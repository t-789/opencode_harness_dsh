/**
 * Background job lifecycle for deepseek_delegate (plan todo 8).
 *
 * Owns everything under one jobs directory (default `<project>/.omo/
 * deepseek-delegate/jobs/`), one artifact set per job:
 *
 *   <job_id>.json          job record, always delegateJobSchema-shaped
 *   <job_id>.request.json  runner request, persisted verbatim
 *   <job_id>.out           child stdout (append; runner prints exactly one
 *                          JSON result line on success paths)
 *   <job_id>.err           child stderr (diagnostics only)
 *
 * A job is the delegate bridge (`scripts/delegate-runner.ts`) executed as a
 * DETACHED child — `bun scripts/delegate-runner.ts --request <json>` — so the
 * job survives the opencode process. The manager keeps an in-process handle
 * per job (child + fd + cancelled flag) and settles the job file from the
 * child's `exit` event; jobs started by a previous process instance are
 * settled lazily the first time they are read after their pid is gone.
 *
 * Status transitions (validated through delegateJobSchema on EVERY write):
 *
 *   running ──natural exit (ok result line)──▶ completed
 *   running ──exit 1/2 or bad/missing line──▶ error
 *   running ──cancel()───────────────────────▶ cancelled
 *
 * Terminal states are immutable: `cancel()` on a non-running job rejects, and
 * a monitor that lost the cancel race re-reads the file instead of overwriting
 * a terminal record.
 *
 * Cancellation mirrors the DSH shutdown ladder (delegate-runner signal
 * handling + the subagent-sdk dispose order): SIGTERM to the child's process
 * GROUP (the child is detached, so the group covers the DSH runtime tree),
 * a short grace window, then SIGKILL to the same group.
 *
 * Concurrency safety: every manager-written JSON file is produced by
 * write-temp-then-rename (atomic on POSIX within one directory), so a
 * concurrent `status()`/`output()` reader never observes a torn file; readers
 * additionally validate through the job schema and surface structured
 * JobErrors instead of crashing. Reads of `.out`/`.err` are tail-capped so a
 * chatty child cannot balloon a tool response.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ZodError } from 'zod'
import { redactSecrets } from '../scripts/runner-lib.ts'
import {
  delegateJobSchema,
  deepseekDelegateOutputSchema,
  type DelegateJob,
  type DelegateOutput,
  type PermissionMode,
  type Preset,
} from './schema.ts'

/* ------------------------------------------------------------------ */
/* Constants and defaults                                              */
/* ------------------------------------------------------------------ */

const THIS_DIR = dirname(fileURLToPath(import.meta.url)) // <project>/src
const PROJECT_ROOT = dirname(THIS_DIR)

/** Default job state directory: `<project>/.omo/deepseek-delegate/jobs/`. */
export const DEFAULT_JOBS_DIR = join(PROJECT_ROOT, '.omo', 'deepseek-delegate', 'jobs')
/** Default runner entry executed as `<bin> <runner> --request <json>`. */
export const DEFAULT_RUNNER = join(PROJECT_ROOT, 'scripts', 'delegate-runner.ts')

/** SIGTERM grace window before escalating to SIGKILL during cancel. */
export const DEFAULT_CANCEL_GRACE_MS = 1500
/** How long to wait after SIGKILL before declaring the cancel failed. */
export const KILL_CONFIRM_MS = 1500

/** Job ids look like `bg_<hex>` (the opencode background-task convention). */
const JOB_ID_PATTERN = /^bg_[a-zA-Z0-9]{8,64}$/
/** Tail caps: never hand the model unbounded child output. */
const TAIL_MAX_LINES = 200
const TAIL_MAX_BYTES = 64 * 1024
const FINAL_LINE_MAX_BYTES = 4 * 1024 * 1024
const ERROR_TAIL_MAX_CHARS = 800

/* ------------------------------------------------------------------ */
/* Structured errors                                                   */
/* ------------------------------------------------------------------ */

export class JobError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'JobError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ */
/* JobSpec and options                                                 */
/* ------------------------------------------------------------------ */

/**
 * Everything the manager needs to mint and start one job.
 *
 * `runner_request` is the delegate-runner request (see runner-lib's
 * DelegateRequest contract: prompt/content_blocks, cwd, session_root,
 * cordis_config, provider/model/permission_mode, ...). It is persisted
 * verbatim as `<job_id>.request.json` and passed to the runner via
 * `--request <json>`. The manager does not re-validate it — the runner's own
 * preflight parses it and, when it is malformed, the job settles as `error`
 * with the runner's BAD_REQUEST/PREFLIGHT payload.
 */
export interface JobSpec {
  preset: Preset
  /** Workspace the delegation runs in (job metadata + runner request cwd). */
  cwd: string
  /** Session id to reuse for follow-up turns, when present. */
  session_id?: string
  /** Computed model id for the preset (never caller-chosen). */
  model: string
  permission_mode: PermissionMode
  /** Verbatim delegate-runner request (JSON-serializable object). */
  runner_request: Record<string, unknown>
}

export interface JobManagerOptions {
  /** Jobs directory; defaults to `DEFAULT_JOBS_DIR`. */
  jobsDir?: string
  /** Runner entry path; defaults to `DEFAULT_RUNNER`. */
  runner?: string
  /**
   * Executable used to run the runner entry. Default resolution order:
   * `process.execPath` when it is bun, `bun` on PATH, `process.execPath`
   * when it is node >= 23.6 (native erasable-TS type stripping), else
   * JobError `BUN_NOT_FOUND`.
   */
  runnerBin?: string
  /** SIGTERM grace window before SIGKILL during cancel. */
  cancelGraceMs?: number
}

/** Terminal/transient view of a job for the output tool (todo 7/10 wiring). */
export interface JobOutputView {
  /** Normalized delegate output mirroring the job state. */
  output: DelegateOutput
  /** Tail of `<job_id>.out` (capped, redacted). Empty when absent. */
  stdout_tail: string
  /** Tail of `<job_id>.err` (capped, redacted). Empty when absent. */
  stderr_tail: string
}

export interface JobPaths {
  dir: string
  json: string
  request: string
  out: string
  err: string
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function secretExtraValues(): string[] {
  const key = process.env.DEEPSEEK_API_KEY
  return key === undefined || key === '' ? [] : [key]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** True when the process is alive (kill(pid, 0) delivered) or permission denies the probe. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return true // EPERM etc.: the pid exists even though we cannot signal it
  }
}

function assertJobId(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new JobError('JOB_INVALID', `malformed job id "${jobId}": expected bg_<hex> (no path separators)`)
  }
  return jobId
}

export function jobPathsFor(jobsDir: string, jobId: string): JobPaths {
  assertJobId(jobId)
  return {
    dir: jobsDir,
    json: join(jobsDir, `${jobId}.json`),
    request: join(jobsDir, `${jobId}.request.json`),
    out: join(jobsDir, `${jobId}.out`),
    err: join(jobsDir, `${jobId}.err`),
  }
}

/**
 * Atomic-ish JSON write: serialize to `<file>.tmp-*` in the same directory,
 * then rename over the target. rename(2) within one directory is atomic on
 * POSIX, so concurrent readers either see the old file or the new file —
 * never a torn write.
 */
function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function formatIssues(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/** Validate a record through delegateJobSchema and persist it atomically. */
function persistJob(file: string, record: DelegateJob): void {
  const parsed = delegateJobSchema.safeParse(record)
  if (!parsed.success) {
    throw new JobError('JOB_INVALID', `refusing to persist an invalid job record: ${formatIssues(parsed.error)}`)
  }
  atomicWriteJson(file, parsed.data)
}

function readJobFile(jobsDir: string, jobId: string): DelegateJob {
  assertJobId(jobId)
  const paths = jobPathsFor(jobsDir, jobId)
  if (!existsSync(paths.json)) {
    throw new JobError('JOB_NOT_FOUND', `no job with id "${jobId}" under ${jobsDir}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(paths.json, 'utf8'))
  } catch (error) {
    throw new JobError('JOB_INVALID', `job file for "${jobId}" is not valid JSON: ${messageOf(error)}`)
  }
  const parsed = delegateJobSchema.safeParse(raw)
  if (!parsed.success) {
    throw new JobError('JOB_INVALID', `job file for "${jobId}" violates the job schema: ${formatIssues(parsed.error)}`)
  }
  return parsed.data
}

/** Read the last non-empty line of a file (seeking from the end when huge). */
function readFinalLine(file: string): string | undefined {
  let stats: Stats
  try {
    stats = statSync(file)
  } catch {
    return undefined
  }
  if (stats.size === 0) return undefined
  const budget = Math.min(stats.size, FINAL_LINE_MAX_BYTES)
  const start = stats.size - budget
  const buffer = Buffer.alloc(budget)
  try {
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, budget, start)
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  const lines = buffer.toString('utf8').split('\n')
  // When truncated, lines[0] may start mid-line — never treat it as complete.
  const firstCompleteIndex = start > 0 ? 1 : 0
  for (let index = lines.length - 1; index >= firstCompleteIndex; index--) {
    const line = lines[index].trim()
    if (line !== '') return line
  }
  return undefined
}

/** Capped tail of a file (last N complete lines, redacted). */
function readTailText(file: string): string {
  let stats: Stats
  try {
    stats = statSync(file)
  } catch {
    return ''
  }
  if (stats.size === 0) return ''
  const budget = Math.min(stats.size, TAIL_MAX_BYTES)
  const start = stats.size - budget
  const buffer = Buffer.alloc(budget)
  try {
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, budget, start)
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
  const lines = buffer.toString('utf8').split('\n')
  if (start > 0) lines.shift() // first chunk may start mid-line
  const complete = lines.filter((line) => line.trim() !== '')
  return redactSecrets(complete.slice(-TAIL_MAX_LINES).join('\n'), secretExtraValues())
}

function closeFd(fd: number | undefined): void {
  if (fd === undefined) return
  try {
    closeSync(fd)
  } catch {
    // already closed — fine
  }
}

/**
 * Resolve the executable that runs `delegate-runner.ts`. The runner uses
 * bun-only TS conventions (explicit `.ts` import specifiers, erasable
 * syntax), which bun and node >= 23.6 both execute natively.
 */
function resolveRunnerExecutable(override: string | undefined): string {
  if (override !== undefined && override !== '') return override
  const exec = process.execPath
  const execBase = basename(exec)
  if (execBase.toLowerCase().startsWith('bun')) return exec
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, 'bun')
    if (existsSync(candidate)) return candidate
  }
  if (execBase.startsWith('node')) {
    const major = Number(process.versions.node.split('.')[0] ?? 0)
    if (!Number.isNaN(major) && major >= 23) return exec
  }
  throw new JobError(
    'BUN_NOT_FOUND',
    'cannot run delegate jobs: no bun on PATH and the host runtime is not bun or node >= 23.6; ' +
      'install bun or pass options.runnerBin',
  )
}

function describeExit(code: number | null, signal: string | null): string {
  if (code !== null) return `with code ${code}`
  if (signal !== null) return `after signal ${signal}`
  return 'unexpectedly'
}

/* ------------------------------------------------------------------ */
/* Runner result line parsing (pure)                                   */
/* ------------------------------------------------------------------ */

/**
 * A parsed delegate-runner result line. Success carries the run's structured
 * fields; failure carries the wire `{ code, message }` error payload.
 */
export type RunnerLineResult =
  | {
      ok: true
      session_id?: string
      final_response?: string
      finish_reason?: string
      events_len?: number
    }
  | { ok: false; error: { code: string; message: string } }

/** Parse one delegate-runner stdout JSON line; undefined when not a result line. */
export function parseRunnerLine(jsonText: string): RunnerLineResult | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return undefined
  }
  const record = asRecord(raw)
  if (record === undefined) return undefined
  if (record.ok === true) {
    return {
      ok: true,
      session_id: typeof record.session_id === 'string' ? record.session_id : undefined,
      final_response: typeof record.final_response === 'string' ? record.final_response : undefined,
      finish_reason: typeof record.finish_reason === 'string' ? record.finish_reason : undefined,
      events_len: typeof record.events_len === 'number' ? record.events_len : undefined,
    }
  }
  if (record.ok === false) {
    const error = asRecord(record.error)
    if (error !== undefined && typeof error.code === 'string' && typeof error.message === 'string') {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
  }
  return undefined
}

function assertOutputShape(output: DelegateOutput): DelegateOutput {
  const parsed = deepseekDelegateOutputSchema.safeParse(output)
  if (!parsed.success) {
    throw new JobError('JOB_INVALID', `normalized output violates the delegate output schema: ${formatIssues(parsed.error)}`)
  }
  return parsed.data
}

/* ------------------------------------------------------------------ */
/* JobManager                                                          */
/* ------------------------------------------------------------------ */

interface ActiveJob {
  child: ChildProcess
  outFd: number
  errFd: number
  /** The job record that was persisted at start (status running). */
  record: DelegateJob
  /** Set synchronously by cancel() before any signal is sent. */
  cancelled: boolean
  /** Set when the exit path has been handled (or skipped as cancelled). */
  settled: boolean
}

export class JobManager {
  readonly jobsDir: string
  readonly runner: string
  readonly runnerBin: string
  readonly cancelGraceMs: number

  private readonly active = new Map<string, ActiveJob>()

  constructor(options: JobManagerOptions = {}) {
    this.jobsDir = options.jobsDir ?? DEFAULT_JOBS_DIR
    this.runner = options.runner ?? DEFAULT_RUNNER
    this.runnerBin = resolveRunnerExecutable(options.runnerBin)
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
  }

  paths(jobId: string): JobPaths {
    return jobPathsFor(this.jobsDir, assertJobId(jobId))
  }

  /* ------------------------------ start ------------------------------ */

  /**
   * Spawn the delegate runner as a detached child and persist a `running`
   * job record. Resolves with the running record (pid included). The child's
   * stdout/stderr are redirected to `<job_id>.out` / `<job_id>.err` (files
   * are created even when the child produces no output), and the runner
   * request is persisted as `<job_id>.request.json`.
   */
  async start(spec: JobSpec): Promise<DelegateJob> {
    const requestJson = serializeRequest(spec.runner_request)
    let jobsDir: string
    try {
      jobsDir = this.ensureJobsDir()
    } catch (error) {
      throw new JobError('JOB_IO', `cannot create jobs dir "${DEFAULT_JOBS_DIR}": ${messageOf(error)}`)
    }
    if (!existsSync(this.runner)) {
      throw new JobError('JOB_INVALID', `runner entry does not exist: ${this.runner}`)
    }
    const id = mintJobId(jobsDir)
    const paths = jobPathsFor(jobsDir, id)
    atomicWriteJson(paths.request, spec.runner_request)

    let outFd: number | undefined
    let errFd: number | undefined
    try {
      outFd = openSync(paths.out, 'a')
      errFd = openSync(paths.err, 'a')
    } catch (error) {
      closeFd(outFd)
      closeFd(errFd)
      rmSync(paths.request, { force: true })
      throw new JobError('JOB_IO', `cannot open output files for job "${id}": ${messageOf(error)}`)
    }

    const child = spawn(this.runnerBin, [this.runner, '--request', requestJson], {
      cwd: dirname(this.runner),
      detached: true, // own process group: survives us; group-killable safely
      stdio: ['ignore', outFd, errFd],
    })
    // A post-spawn error must not crash the parent as an unhandled 'error'.
    child.on('error', (error) => {
      console.error(`deepseek_delegate jobs: job ${id} child error: ${messageOf(error)}`)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', (error) => reject(new JobError('SPAWN_FAILED', `cannot start ${id}: ${messageOf(error)}`)))
      })
    } catch (error) {
      closeFd(outFd)
      closeFd(errFd)
      rmSync(paths.request, { force: true })
      throw error
    }

    const record: DelegateJob = {
      job_id: id,
      preset: spec.preset,
      created_at: new Date().toISOString(),
      cwd: spec.cwd,
      status: 'running',
      model: spec.model,
      permission_mode: spec.permission_mode,
      ...(spec.session_id === undefined ? {} : { session_id: spec.session_id }),
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    }
    const handle: ActiveJob = { child, outFd, errFd, record, cancelled: false, settled: false }
    try {
      persistJob(paths.json, record)
    } catch (error) {
      this.active.delete(id)
      this.signalGroup(child.pid, 'SIGKILL')
      closeFd(outFd)
      closeFd(errFd)
      rmSync(paths.request, { force: true })
      rmSync(paths.json, { force: true })
      throw error
    }
    this.active.set(id, handle)
    // 'exit' is a macrotask; everything above ran in one microtask chain, so
    // the running record is persisted before any exit event can be observed.
    child.on('exit', () => this.onChildExit(id))
    if (child.exitCode !== null || child.signalCode !== null) this.onChildExit(id) // exited pre-listener
    return record
  }

  /* ------------------------------ status ----------------------------- */

  /**
   * Read `<job_id>.json` and return the validated job record. A `running`
   * record whose child is gone without the manager having settled it (the
   * manager process died, or the child was killed externally) is settled
   * lazily from `.out` before returning.
   */
  async status(jobId: string): Promise<DelegateJob> {
    const id = assertJobId(jobId)
    const record = readJobFile(this.jobsDir, id)
    if (record.status !== 'running') return record
    const handle = this.active.get(id)
    if (handle !== undefined) return record // in-process monitor owns settlement
    if (record.pid === undefined || pidAlive(record.pid)) return record
    // Orphaned/dead running job: reconstruct the terminal state from .out.
    try {
      const terminal = this.computeTerminalRecord(record, null, null)
      persistJob(jobPathsFor(this.jobsDir, id).json, terminal)
      return terminal
    } catch (error) {
      throw new JobError('JOB_INVALID', `cannot settle dead job "${id}": ${messageOf(error)}`)
    }
  }

  /* ------------------------------ output ----------------------------- */

  /**
   * Normalized view of a job for the output tool.
   *
   *  - completed: `.output` is the final DelegateOutput parsed from the
   *    runner's last `.out` JSON line (validated through
   *    deepseekDelegateOutputSchema);
   *  - running:   `.output.status` is `running` and `.out`/`.err` tails are
   *    attached for progress;
   *  - error/cancelled: `.output` carries the terminal status and, for
   *    errors, the structured `{ code, message }` payload.
   */
  async output(jobId: string): Promise<JobOutputView> {
    const id = assertJobId(jobId)
    const record = await this.status(id)
    const paths = jobPathsFor(this.jobsDir, id)
    const stdoutTail = readTailText(paths.out)
    const stderrTail = readTailText(paths.err)

    const base = (status: DelegateJob['status']): DelegateOutput =>
      assertOutputShape({
        status,
        preset: record.preset,
        job_id: record.job_id,
        ...(record.session_id === undefined ? {} : { session_id: record.session_id }),
        model: record.model,
        permission_mode: record.permission_mode,
      })

    switch (record.status) {
      case 'completed': {
        let result = record.result
        if (result === undefined) {
          // Older/corner-state record: reconstruct from the .out line.
          const terminal = this.computeTerminalRecord(record, 0, null)
          result = terminal.result
        }
        if (result === undefined) throw new JobError('JOB_INVALID', `job "${id}" is completed but has no result`)
        return { output: assertOutputShape(result), stdout_tail: stdoutTail, stderr_tail: stderrTail }
      }
      case 'error':
        return {
          output: assertOutputShape({ ...base('error'), ...(record.error === undefined ? {} : { error: record.error }) }),
          stdout_tail: stdoutTail,
          stderr_tail: stderrTail,
        }
      case 'cancelled':
        return { output: base('cancelled'), stdout_tail: stdoutTail, stderr_tail: stderrTail }
      case 'running':
        return { output: base('running'), stdout_tail: stdoutTail, stderr_tail: stderrTail }
    }
  }

  /* ------------------------------ cancel ----------------------------- */

  /**
   * Cancel a running job: SIGTERM its process group, wait `cancelGraceMs`,
   * then SIGKILL the group when it is still alive. Waits for the process to
   * actually die (retry window) before persisting `status: 'cancelled'`, so
   * a successful cancel() implies the child is reaped. Rejects with
   * `JOB_NOT_RUNNING` for terminal jobs and `CANCEL_FAILED` when the process
   * survives both signals.
   */
  async cancel(jobId: string): Promise<DelegateJob> {
    const id = assertJobId(jobId)
    const initial = readJobFile(this.jobsDir, id)
    if (initial.status !== 'running') {
      throw new JobError('JOB_NOT_RUNNING', `job "${id}" is ${initial.status}; only running jobs can be cancelled`)
    }
    const handle = this.active.get(id)
    if (handle !== undefined) {
      if (handle.cancelled) return readJobFile(this.jobsDir, id) // concurrent cancel in flight
      handle.cancelled = true // block the exit monitor from settling first
    }
    const pid = handle?.child.pid ?? initial.pid
    if (pid === undefined) {
      if (handle !== undefined) handle.cancelled = false
      throw new JobError('CANCEL_FAILED', `job "${id}" is running but has no recorded pid to signal`)
    }
    try {
      await this.killTree(pid, handle?.child)
    } catch (error) {
      if (handle !== undefined) handle.cancelled = false
      throw error
    }
    // The exit monitor may have settled the job (status completed/error) while
    // we waited — never overwrite a terminal state with cancelled.
    const current = readJobFile(this.jobsDir, id)
    if (current.status !== 'running') return current
    const cancelled: DelegateJob = { ...current, status: 'cancelled' }
    persistJob(jobPathsFor(this.jobsDir, id).json, cancelled)
    return cancelled
  }

  /* --------------------------- internals ----------------------------- */

  private ensureJobsDir(): string {
    mkdirSync(this.jobsDir, { recursive: true })
    return this.jobsDir
  }

  /** Exit monitor: settle the job file from the child's terminal state. */
  private onChildExit(jobId: string): void {
    const handle = this.active.get(jobId)
    if (handle === undefined || handle.settled) return
    handle.settled = true
    this.active.delete(jobId)
    closeFd(handle.outFd)
    closeFd(handle.errFd)
    if (handle.cancelled) return // cancel() owns the terminal write
    try {
      const paths = jobPathsFor(this.jobsDir, jobId)
      let record: DelegateJob
      try {
        record = readJobFile(this.jobsDir, jobId)
      } catch {
        record = handle.record // file vanished mid-flight: settle from memory
      }
      if (record.status !== 'running') return // already terminal (cancel race)
      const terminal = this.computeTerminalRecord(record, handle.child.exitCode, handle.child.signalCode)
      persistJob(paths.json, terminal)
    } catch (error) {
      console.error(`deepseek_delegate jobs: failed to settle job ${jobId}: ${messageOf(error)}`)
    }
  }

  /**
   * Build the terminal job record from the child's exit state:
   *   ok result line + exit 0        -> completed (result parsed from .out)
   *   ok:false result line           -> error    (runner error payload)
   *   no/malformed line              -> error    (RUNNER_EXIT / SIGNAL / NO_OUTPUT)
   * Unknown exit info (lazy settle) trusts a present ok line.
   */
  private computeTerminalRecord(
    record: DelegateJob,
    exitCode: number | null,
    signalCode: string | null,
  ): DelegateJob {
    const paths = jobPathsFor(this.jobsDir, record.job_id)
    const line = readFinalLine(paths.out)
    const parsed = line === undefined ? undefined : parseRunnerLine(line)
    const errTail = readTailText(paths.err).trim()
    if (parsed?.ok === true) {
      if (exitCode === 0 || (exitCode === null && signalCode === null)) {
        const sessionId = parsed.session_id ?? record.session_id
        const result: DelegateOutput = assertOutputShape({
          status: 'completed',
          preset: record.preset,
          job_id: record.job_id,
          ...(sessionId === undefined ? {} : { session_id: sessionId }),
          model: record.model,
          permission_mode: record.permission_mode,
          final_response: parsed.final_response ?? '',
          finish_reason: parsed.finish_reason ?? 'unknown',
        })
        return { ...record, status: 'completed', result }
      }
      return this.errorRecord(record, 'RUNNER_EXIT', `runner printed an ok result but exited ${describeExit(exitCode, signalCode)}`)
    }
    if (parsed?.ok === false) {
      return this.errorRecord(record, parsed.error.code, parsed.error.message)
    }
    if (signalCode !== null && exitCode === null) {
      return this.errorRecord(record, 'SIGNAL', `job terminated by signal ${signalCode}`)
    }
    const context = exitCode === null && signalCode === null ? 'NO_OUTPUT' : 'RUNNER_EXIT'
    const message =
      context === 'NO_OUTPUT'
        ? 'job ended without producing a result line'
        : `delegate runner exited ${describeExit(exitCode, signalCode)} without a result line`
    const withTail = errTail === '' ? message : `${message}; stderr tail: ${errTail.slice(0, ERROR_TAIL_MAX_CHARS)}`
    return this.errorRecord(record, context, withTail)
  }

  private errorRecord(record: DelegateJob, code: string, message: string): DelegateJob {
    const clean = redactSecrets(message, secretExtraValues())
    return { ...record, status: 'error', error: { code: code || 'RUNNER_ERROR', message: clean || code || 'unknown runner error' } }
  }

  /** SIGTERM -> grace -> SIGKILL ladder against the child's process group. */
  private async killTree(pid: number, child: ChildProcess | undefined): Promise<void> {
    const alive = (): boolean =>
      child !== undefined ? child.exitCode === null && child.signalCode === null : pidAlive(pid)
    if (!alive()) return
    this.signalGroup(pid, 'SIGTERM')
    await this.waitForNot(alive, this.cancelGraceMs)
    if (!alive()) return
    this.signalGroup(pid, 'SIGKILL')
    await this.waitForNot(alive, KILL_CONFIRM_MS)
    if (alive()) {
      throw new JobError('CANCEL_FAILED', `job pid ${pid} survived SIGTERM and SIGKILL`)
    }
  }

  /**
   * Signal the child's whole process group (detached children are group
   * leaders, so `-pid` covers the delegate-runner AND its DSH runtime tree —
   * mirroring the stdin-EOF -> SIGTERM -> SIGKILL shutdown ladder). Falls
   * back to a single-process signal for non-group children.
   */
  private signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return // already gone
      try {
        process.kill(pid, signal)
        return
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw new JobError('CANCEL_FAILED', `cannot deliver ${signal} to pid ${pid}: ${messageOf(fallbackError)}`)
        }
      }
    }
  }

  private async waitForNot(alive: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!alive()) return
      await sleep(25)
    }
  }
}

function mintJobId(jobsDir: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `bg_${randomBytes(6).toString('hex')}` // 12 hex chars
    if (!existsSync(join(jobsDir, `${id}.json`))) return id
  }
  throw new JobError('JOB_IO', 'could not mint a unique bg_ job id')
}

function serializeRequest(request: Record<string, unknown>): string {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new JobError('INVALID_SPEC', 'runner_request must be a JSON object')
  }
  try {
    return JSON.stringify(request)
  } catch (error) {
    throw new JobError('INVALID_SPEC', `runner_request is not JSON-serializable: ${messageOf(error)}`)
  }
}
