/**
 * Background job lifecycle tests for deepseek_delegate (plan todo 8).
 *
 * Credential-free and DSH-free: every job is a STUB child script (a tiny
 * bun-runnable .ts file written to a temp dir), so no DeepSeek API key and no
 * runtime boot are involved. Coverage:
 *   happy    – stub completes, status() settles to completed, output() returns
 *              the final normalized DelegateOutput;
 *   cancel   – a SIGTERM-ignoring long-running stub is cancelled via the
 *              SIGTERM -> SIGKILL ladder; status becomes cancelled, the child
 *              pid is provably gone (process.kill(pid, 0) -> ESRCH, retry
 *              window), and .out/.err exist;
 *   malformed – nonexistent/corrupt jobs surface structured JobErrors;
 *   conformance – every job file written under the jobs dir validates against
 *              delegateJobSchema.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { delegateJobSchema, type Preset } from '../src/schema.ts'
import { JobError, JobManager, type JobSpec } from '../src/jobs.ts'

/* ------------------------------------------------------------------ */
/* Stub child scripts (hermetic replacements for delegate-runner.ts)   */
/* ------------------------------------------------------------------ */

/**
 * Happy stub: sleeps ~300 ms, then prints exactly one delegate-runner-
 * contract result line to stdout (writeSync = synchronous fd write, same
 * discipline as the runner's exitWith) and exits 0.
 */
const STUB_COMPLETE_SRC = `// Hermetic todo-8 stub: complete after a short sleep.
import { writeSync } from 'node:fs'
await new Promise<void>((resolve) => setTimeout(resolve, 300))
const payload = {
  ok: true,
  session_id: 'ses_stub_happy',
  final_response: 'stub task completed',
  finish_reason: 'completed',
  events_len: 3,
}
writeSync(1, JSON.stringify(payload) + '\\n')
`

/**
 * Cancel stub: prints a progress line, then IGNORES SIGTERM so the cancel
 * ladder must escalate to SIGKILL (proving no child can survive a cancel).
 */
const STUB_CANCEL_SRC = `// Hermetic todo-8 stub: long-running, SIGTERM-resistant.
import { writeSync } from 'node:fs'
writeSync(1, 'stub: started\\n')
writeSync(2, 'stub: waiting for cancellation\\n')
process.on('SIGTERM', () => {
  writeSync(2, 'stub: SIGTERM received (ignored to force SIGKILL escalation)\\n')
})
setInterval(() => {}, 60_000)
`

let fixturesDir: string
let stubComplete: string
let stubCancel: string

beforeAll(() => {
  fixturesDir = mkdtempSync(join(tmpdir(), 'jobs-fixtures-'))
  stubComplete = join(fixturesDir, 'stub-complete.ts')
  stubCancel = join(fixturesDir, 'stub-cancel.ts')
  writeFileSync(stubComplete, STUB_COMPLETE_SRC, 'utf8')
  writeFileSync(stubCancel, STUB_CANCEL_SRC, 'utf8')
})

afterAll(() => {
  rmSync(fixturesDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function stubSpec(cwd: string, preset: Preset = 'explore'): JobSpec {
  return {
    preset,
    cwd,
    model: 'deepseek-v4-flash',
    permission_mode: 'read-only',
    runner_request: {
      prompt: 'stub prompt — never reaches any model',
      cwd,
      session_root: join(cwd, 'sessions'),
      cordis_config: join(cwd, 'cordis.yml'),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      permission_mode: 'read-only',
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 30): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(intervalMs)
  }
  throw new Error(`condition not met within ${timeoutMs} ms`)
}

/** True only when kill(pid, 0) reports the process is gone (ESRCH thrown). */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function expectJobError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(JobError)
    expect((error as JobError).code).toBe(code)
    return
  }
  throw new Error(`expected JobError with code "${code}" but the promise resolved`)
}

/** Every `<job_id>.json` under jobsDir must satisfy delegateJobSchema. */
function assertAllJobFilesConform(jobsDir: string): void {
  const files = readdirSync(jobsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.request.json'))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(jobsDir, file), 'utf8')) as unknown
    const parsed = delegateJobSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new Error(`job file ${file} violates delegateJobSchema: ${issues}`)
    }
  }
}

function readJobFileRaw(jobsDir: string, jobId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(jobsDir, `${jobId}.json`), 'utf8')) as Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/* Happy path: complete a stub job and read the normalized output      */
/* ------------------------------------------------------------------ */

test('happy: stub background job completes; output() returns the final normalized DelegateOutput', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jobs-test-happy-'))
  const jobsDir = join(tmp, 'jobs')
  try {
    const manager = new JobManager({ jobsDir, runner: stubComplete, cancelGraceMs: 150 })
    const request = stubSpec(tmp)

    const running = await manager.start(request)
    expect(running.job_id).toMatch(/^bg_[a-f0-9]{12}$/)
    expect(running.status).toBe('running')
    expect(running.preset).toBe('explore')
    expect(typeof running.pid).toBe('number')
    expect((running.pid as number) > 0).toBe(true)
    expect(() => process.kill(running.pid as number, 0)).not.toThrow() // child is live
    expect(running.created_at).toBeDefined()

    // Artifacts exist and the persisted request round-trips.
    const paths = manager.paths(running.job_id)
    expect(existsSync(paths.request)).toBe(true)
    expect(JSON.parse(readFileSync(paths.request, 'utf8'))).toEqual(request.runner_request)
    expect(existsSync(paths.out)).toBe(true)
    expect(existsSync(paths.err)).toBe(true)

    // The running record on disk conforms to the schema.
    expect(delegateJobSchema.safeParse(readJobFileRaw(jobsDir, running.job_id)).success).toBe(true)

    // Poll until the exit monitor settles the job as completed.
    await waitFor(async () => (await manager.status(running.job_id)).status === 'completed', 10_000)
    const settled = await manager.status(running.job_id)
    expect(settled.status).toBe('completed')
    expect(settled.result?.status).toBe('completed')
    expect(settled.pid).toBe(running.pid)

    // output() returns the final normalized DelegateOutput.
    const view = await manager.output(running.job_id)
    expect(view.output.status).toBe('completed')
    expect(view.output.preset).toBe('explore')
    expect(view.output.job_id).toBe(running.job_id)
    expect(view.output.session_id).toBe('ses_stub_happy')
    expect(view.output.final_response).toBe('stub task completed')
    expect(view.output.finish_reason).toBe('completed')
    expect(view.output.model).toBe('deepseek-v4-flash')
    expect(view.output.permission_mode).toBe('read-only')

    // The runner's single result line was captured verbatim in .out.
    const outText = readFileSync(paths.out, 'utf8').trim()
    const outLine = JSON.parse(outText) as { ok: boolean; session_id: string; final_response: string }
    expect(outLine.ok).toBe(true)
    expect(outLine.final_response).toBe('stub task completed')

    assertAllJobFilesConform(jobsDir)

    // output() is idempotent on a terminal job.
    const again = await manager.output(running.job_id)
    expect(again.output.status).toBe('completed')
    // ...and canceling a completed job is a structured rejection.
    await expectJobError(manager.cancel(running.job_id), 'JOB_NOT_RUNNING')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}, 20_000)

/* ------------------------------------------------------------------ */
/* Failure path: cancel a long-running job, assert full reap           */
/* ------------------------------------------------------------------ */

test('failure/cancel: long-running stub is cancelled; pid reaped (ESRCH); .out/.err exist', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jobs-test-cancel-'))
  const jobsDir = join(tmp, 'jobs')
  try {
    const manager = new JobManager({ jobsDir, runner: stubCancel, cancelGraceMs: 200 })
    const running = await manager.start(stubSpec(tmp))
    const paths = manager.paths(running.job_id)
    const pid = running.pid as number

    // Wait until the stub is really up: progress line captured + process live.
    await waitFor(() => pidGone(pid) === false && existsSync(paths.out) && readFileSync(paths.out, 'utf8').includes('stub: started'), 10_000)

    // While running, output() reports running + live tails.
    const runningView = await manager.output(running.job_id)
    expect(runningView.output.status).toBe('running')
    expect(runningView.output.job_id).toBe(running.job_id)
    expect(runningView.stdout_tail).toContain('stub: started')
    expect(runningView.stderr_tail).toContain('waiting for cancellation')

    // Cancel: SIGTERM (ignored by the stub) then SIGKILL escalation.
    const cancelled = await manager.cancel(running.job_id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.job_id).toBe(running.job_id)

    // Job file persisted as cancelled.
    const afterCancel = await manager.status(running.job_id)
    expect(afterCancel.status).toBe('cancelled')

    // No child process remains: kill(pid, 0) must throw ESRCH (retry window).
    await waitFor(() => pidGone(pid), 5_000)
    expect(pidGone(pid)).toBe(true)

    // The escalation ladder actually ran: SIGTERM was delivered and ignored.
    const cancelView = await manager.output(running.job_id)
    expect(cancelView.output.status).toBe('cancelled')
    expect(cancelView.stderr_tail).toContain('SIGTERM received')

    // stdout/stderr capture files exist (spec requirement).
    expect(existsSync(paths.out)).toBe(true)
    expect(existsSync(paths.err)).toBe(true)
    expect(statSync(paths.out).size).toBeGreaterThan(0)
    expect(statSync(paths.err).size).toBeGreaterThan(0)

    assertAllJobFilesConform(jobsDir)

    // Double cancel is a structured rejection, not a crash.
    await expectJobError(manager.cancel(running.job_id), 'JOB_NOT_RUNNING')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}, 20_000)

/* ------------------------------------------------------------------ */
/* Malformed inputs: structured errors, never crashes                  */
/* ------------------------------------------------------------------ */

test('malformed: nonexistent / malformed jobs yield structured JobErrors', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jobs-test-malformed-'))
  const jobsDir = join(tmp, 'jobs')
  try {
    const manager = new JobManager({ jobsDir, runner: stubComplete, cancelGraceMs: 150 })
    const missing = 'bg_000000000000'

    await expectJobError(manager.status(missing), 'JOB_NOT_FOUND')
    await expectJobError(manager.output(missing), 'JOB_NOT_FOUND')
    await expectJobError(manager.cancel(missing), 'JOB_NOT_FOUND')

    // Ids that are not bg_<hex> are rejected before any file access.
    await expectJobError(manager.status('../evil'), 'JOB_INVALID')
    await expectJobError(manager.output('bg_short'), 'JOB_INVALID')

    // A corrupt job file surfaces JOB_INVALID instead of crashing.
    const corruptDir = join(tmp, 'jobs-corrupt')
    const corruptManager = new JobManager({ jobsDir: corruptDir, runner: stubComplete, cancelGraceMs: 150 })
    const corruptId = 'bg_corrupt000001'
    await corruptManager.start(stubSpec(tmp)) // creates jobs dir
    writeFileSync(join(corruptDir, `${corruptId}.json`), '{not json', 'utf8')
    await expectJobError(corruptManager.status(corruptId), 'JOB_INVALID')
    await expectJobError(corruptManager.output(corruptId), 'JOB_INVALID')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}, 20_000)

/** A second happy path: an error-contract stub settles the job as `error`. */
test('error: stub printing an ok:false line settles the job as error with structured payload', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jobs-test-error-'))
  const jobsDir = join(tmp, 'jobs')
  const stubError = join(fixturesDir, 'stub-error.ts')
  writeFileSync(
    stubError,
    `// Hermetic todo-8 stub: fails with a runner-contract error line, exit 1.
import { writeSync } from 'node:fs'
writeSync(1, JSON.stringify({ ok: false, error: { code: 'AGENT_ERROR', message: 'stub blew up on purpose' } }) + '\\n')
process.exit(1)
`,
    'utf8',
  )
  try {
    const manager = new JobManager({ jobsDir, runner: stubError, cancelGraceMs: 150 })
    const running = await manager.start(stubSpec(tmp))
    await waitFor(async () => (await manager.status(running.job_id)).status === 'error', 10_000)
    const settled = await manager.status(running.job_id)
    expect(settled.status).toBe('error')
    expect(settled.error?.code).toBe('AGENT_ERROR')

    const view = await manager.output(running.job_id)
    expect(view.output.status).toBe('error')
    expect(view.output.error?.code).toBe('AGENT_ERROR')
    expect(view.output.error?.message).toContain('stub blew up')
    assertAllJobFilesConform(jobsDir)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}, 20_000)
