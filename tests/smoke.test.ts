/**
 * Credential-gated smoke tests for deepseek_delegate against the REAL DSH
 * runtime (plan todo 11, test suite + smoke).
 *
 * GATING (hard rule): every test in this file is SKIPPED unless BOTH
 *   - RUN_DSH_SMOKE=1          (explicit opt-in: a live key in the shell is
 *                               NOT enough — real model calls only on demand)
 *   - DEEPSEEK_API_KEY          (a real credential in the environment)
 * are present. When skipped the module prints one clear reason line and the
 * tests register as bun `test.skip` entries, so `bun test` (the default,
 * credential-free command) and CI stay green — the file never calls the API
 * unless the operator opted in.
 *
 * When ENABLED, these tests exercise the REAL end-to-end stack — no stubs:
 *
 *   runDelegate (src/delegate-execute.ts)
 *     → real JobManager (src/jobs.ts, temp jobs dir)
 *       → bun scripts/delegate-runner.ts  (real delegate bridge)
 *         → @deepseek-ai/dsh-sdk-client DeepSeekHarness child
 *           → @deepseek-ai/dsh-sdk-jsonrpc-demo runtime booted with the
 *             sandboxed dsh/cordis compositions + the real DeepSeek API.
 *
 * Scenarios (each is a real, small model call):
 *   1. explore happy      — a read-only delegation completes and its final
 *                           response contains the SMOKE_OK_EXPLORE marker.
 *   2. read-only deny     — an explore (read-only) delegation is asked to
 *                           write a file: the sandboxed composition must deny
 *                           it. Proof: the probe file does NOT exist after the
 *                           run AND the model reports the denial. This is the
 *                           live proof that read-only is enforced through the
 *                           real runtime, not a stub.
 *   3. workspace-write    — a write-preset delegation with a context packet
 *                           must be ALLOWED to create smoke.txt ("ok") in its
 *                           temp workspace (workspace-write permits it).
 *
 * HYGIENE: each run gets a fresh mkdtemp workspace + temp jobs dir under the
 * OS temp dir. After every run the workspace, jobs dir, and the DSH session
 * artifacts for that exact run are deleted; afterAll scans pgrep and asserts
 * that no delegate-runner / dsh-sdk-jsonrpc-demo child process survived.
 *
 * BUDGET: real model latency varies, so the per-run deadline is
 * DSH_SMOKE_TIMEOUT_MS (default 240 000 ms), honored by runDelegate's own
 * timeout machinery (cancel ladder on expiry). The bun per-test timeout is
 * budget + 90 s slack so bun is only a backstop, never the binding cancel.
 */
import { afterAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runDelegate, type RunDelegateDeps } from '../src/delegate-execute.ts'
import { JobManager } from '../src/jobs.ts'
import { SESSION_ROOT } from '../src/preset-map.ts'
import type { ContextPacket, DelegateInput, DelegateOutput } from '../src/schema.ts'

/* ------------------------------------------------------------------ */
/* Gate                                                               */
/* ------------------------------------------------------------------ */

const RUN_DSH_SMOKE = process.env.RUN_DSH_SMOKE === '1'
const HAS_API_KEY = (process.env.DEEPSEEK_API_KEY ?? '') !== ''
export const ENABLED = RUN_DSH_SMOKE && HAS_API_KEY

const SKIP_REASON = !RUN_DSH_SMOKE
  ? 'RUN_DSH_SMOKE is not set to 1 — live DeepSeek calls are opt-in only (set RUN_DSH_SMOKE=1 to run)'
  : 'DEEPSEEK_API_KEY is not present in the environment — live DeepSeek calls need a credential'

if (!ENABLED) {
  // One clear line when the suite cannot run (also visible in `bun test` runs).
  console.error(`[dsh-smoke] SKIPPED — ${SKIP_REASON}. No real model calls were made.`)
}

/* ------------------------------------------------------------------ */
/* Budget + test registration                                         */
/* ------------------------------------------------------------------ */

const DEFAULT_BUDGET_MS = 240_000

function envBudgetMs(): number {
  const raw = process.env.DSH_SMOKE_TIMEOUT_MS
  if (raw === undefined || raw === '') return DEFAULT_BUDGET_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_BUDGET_MS
}

/** Per-run deadline honored by runDelegate (input.timeout_ms). */
const BUDGET_MS = envBudgetMs()
/** bun per-test backstop: budget + 90 s slack for boot + model latency. */
const BUN_TEST_TIMEOUT_MS = BUDGET_MS + 90_000

const maybe = ENABLED ? test : test.skip

/* ------------------------------------------------------------------ */
/* Hygiene helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Reimplementation of dsh-session-persistence-jsonl's project-directory key
 * (lib/index.js `projectKey`), so session cleanup can target EXACTLY the
 * artifacts of one run. Layout: <SESSION_ROOT>/<projectKey(cwd)>/<session>/
 * session.jsonl(.zstd). The delegation cwd is a fresh mkdtemp dir per run, so
 * its project key is unique to this smoke run and safe to delete wholesale.
 */
function sessionProjectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function sessionProjectDirFor(cwdAbs: string): string {
  return join(SESSION_ROOT, sessionProjectKey(cwdAbs))
}

/** Remove the DSH session artifacts written for one run's workspace. */
function removeSessionArtifacts(cwdAbs: string): void {
  rmSync(sessionProjectDirFor(cwdAbs), { recursive: true, force: true })
  sweepEmptyDelegateRoots()
}

/** Drop the delegate state roots when empty (the runner mkdirs them lazily). */
function sweepEmptyDelegateRoots(): void {
  // Note: bun 1.3.11 rmSync with recursive:false throws EFAULT even on empty
  // dirs (verified with a probe), so guard with an explicit emptiness check
  // and remove recursively — a checked-empty dir cannot hold foreign state.
  for (const dir of [SESSION_ROOT, dirname(SESSION_ROOT)]) {
    try {
      if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // vanished mid-check, not a dir, or not empty — leave it alone
    }
  }
}

/** pgrep scan for leftover DSH/delegate children ([] = clean). */
function dshChildLines(): string[] {
  try {
    const out = execFileSync('pgrep', ['-fl', 'delegate-runner|dsh-sdk-jsonrpc-demo'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    return out.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  } catch {
    return [] // pgrep exit 1 (no match) or missing binary — nothing alive
  }
}

/* ------------------------------------------------------------------ */
/* Real-run helpers                                                   */
/* ------------------------------------------------------------------ */

interface RealRunResult {
  output: DelegateOutput
  /** stderr tail of the delegate-runner child ('' when the job had none). */
  stderr_tail: string
}

function describeOutput(output: DelegateOutput): string {
  return JSON.stringify(output, null, 2)
}

/**
 * Run one REAL delegation end to end inside a fresh temp workspace with a
 * real JobManager (temp jobs dir). Resolves with the terminal output plus the
 * runner stderr tail for diagnostics. The caller owns cleanup via the
 * returned root (or by passing `root` through the finally below — see
 * `withRealRun`).
 */
async function realDelegateRun(
  input: DelegateInput,
  jobs: JobManager,
  root: string,
): Promise<RealRunResult> {
  const deps: RunDelegateDeps = {
    startJob: (spec) => jobs.start(spec),
    readOutput: (jobId) => jobs.output(jobId),
    cancelJob: (jobId) => jobs.cancel(jobId),
  }
  const output = await runDelegate(input, deps)
  let stderr_tail = ''
  if (output.job_id !== undefined) {
    try {
      const view = await jobs.output(output.job_id)
      stderr_tail = view.stderr_tail
    } catch {
      // job artifacts already gone — diagnostics only
    }
  }
  void root
  return { output, stderr_tail }
}

/** Per-run workspace/jobs layout; cleanup happens in the test's finally. */
function makeRunRoot(): { root: string; workspace: string; jobsDir: string; manager: JobManager } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const jobsDir = join(root, 'jobs')
  const manager = new JobManager({ jobsDir })
  return { root, workspace, jobsDir, manager }
}

function cleanRun(root: string, workspace: string): void {
  removeSessionArtifacts(workspace)
  rmSync(root, { recursive: true, force: true })
}

function requireCompleted(output: DelegateOutput, context: string, stderrTail: string): void {
  if (output.status !== 'completed') {
    const tail = stderrTail === '' ? '' : `\ndelegate-runner stderr tail:\n${stderrTail}`
    throw new Error(
      `${context}: delegation did not complete (status "${output.status}").\n` +
        `output: ${describeOutput(output)}${tail}`,
    )
  }
}

function denialReported(finalResponse: string): boolean {
  return /denied|deny|read-only|not permitted|not allowed|refused|rejected|sandbox|forbidden|cannot write|could not write|couldn't write|unable to write|blocked/i.test(
    finalResponse,
  )
}

/* ------------------------------------------------------------------ */
/* afterAll: no child processes, no stray state                        */
/* ------------------------------------------------------------------ */

afterAll(() => {
  if (!ENABLED) return
  // All children are gone by now (asserted below) — sweep the delegate state
  // roots the runs created; nothing can recreate them while no child is alive.
  sweepEmptyDelegateRoots()
  const leftovers = dshChildLines()
  if (leftovers.length > 0) {
    console.error('[dsh-smoke] leftover DSH child processes detected:\n' + leftovers.join('\n'))
  }
  expect(leftovers, 'no delegate-runner/dsh-sdk-jsonrpc-demo children may survive the smoke suite').toEqual([])
})

/* ------------------------------------------------------------------ */
/* Smoke scenarios                                                    */
/* ------------------------------------------------------------------ */

maybe(
  'explore happy path: real read-only delegation completes and echoes the marker',
  async () => {
    const { root, workspace, manager } = makeRunRoot()
    try {
      const { output, stderr_tail } = await realDelegateRun(
        {
          preset: 'explore',
          prompt: 'Reply with exactly SMOKE_OK_EXPLORE. Do not use tools.',
          cwd: workspace,
          timeout_ms: BUDGET_MS,
        },
        manager,
        root,
      )
      requireCompleted(output, 'explore happy path', stderr_tail)
      expect(output.permission_mode).toBe('read-only')
      expect(output.finish_reason).toBeDefined()
      expect(output.final_response ?? '').toContain('SMOKE_OK_EXPLORE')
    } finally {
      cleanRun(root, workspace)
    }
  },
  { timeout: BUN_TEST_TIMEOUT_MS },
)

maybe(
  'read-only enforcement: a write attempt under explore is denied and leaves no file',
  async () => {
    const { root, workspace, manager } = makeRunRoot()
    const probePath = join(workspace, 'dsh_deny_probe.txt')
    try {
      const { output, stderr_tail } = await realDelegateRun(
        {
          preset: 'explore',
          prompt:
            'Attempt to write a file named dsh_deny_probe.txt in your current workspace ' +
            'containing the text "probe". Use your file tools to actually try the write. ' +
            'Then report exactly what happened when you tried to write the file.',
          cwd: workspace,
          timeout_ms: BUDGET_MS,
        },
        manager,
        root,
      )
      requireCompleted(output, 'read-only denial', stderr_tail)
      const finalResponse = output.final_response ?? ''
      expect(finalResponse.length).toBeGreaterThan(0)
      // Enforcement proof: the sandboxed composition denied the write, so the
      // file must not exist after the run (deterministic, model-independent).
      expect(
        existsSync(probePath),
        'a file written under preset "explore" (read-only) proves the sandbox did NOT enforce read-only',
      ).toBe(false)
      // The model must report the denial it observed (wording tolerant).
      expect(denialReported(finalResponse), `model did not report the read-only denial. final_response:\n${finalResponse}`).toBe(true)
    } finally {
      cleanRun(root, workspace)
    }
  },
  { timeout: BUN_TEST_TIMEOUT_MS },
)

maybe(
  'workspace-write preset: the delegated file is created inside the temp workspace',
  async () => {
    const { root, workspace, manager } = makeRunRoot()
    const smokePath = join(workspace, 'smoke.txt')
    try {
      const packet: ContextPacket = {
        objective: 'Create a file named smoke.txt in the workspace containing exactly the text "ok".',
        relevant_paths: ['.'],
        verification_commands: ['ls smoke.txt'],
      }
      const { output, stderr_tail } = await realDelegateRun(
        {
          preset: 'write',
          prompt: 'Follow the task contract and create smoke.txt.',
          cwd: workspace,
          context_packet: packet,
          timeout_ms: BUDGET_MS,
        },
        manager,
        root,
      )
      requireCompleted(output, 'workspace-write smoke', stderr_tail)
      expect(output.permission_mode).toBe('workspace-write')
      expect(
        existsSync(smokePath),
        'smoke.txt was not created: workspace-write should permit in-workspace writes',
      ).toBe(true)
      expect(readFileSync(smokePath, 'utf8').trim()).toBe('ok')
    } finally {
      cleanRun(root, workspace)
    }
  },
  { timeout: BUN_TEST_TIMEOUT_MS },
)
