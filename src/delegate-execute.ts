/**
 * deepseek_delegate execute-path core (plan todo 7).
 *
 * Everything between the opencode custom-tool boundary and the background
 * job layer (`src/jobs.ts`), kept free of `@opencode-ai/plugin` imports so
 * tests can drive it with stubbed job seams and never touch a real API:
 *
 *   runDelegate(input, deps)   — validate → build prompt/blocks → map →
 *                                start job → (background: return running |
 *                                sync: poll until terminal, honoring the
 *                                deadline, cancelling on timeout) → normalize
 *                                the terminal output into a concise,
 *                                schema-valid DelegateOutput.
 *
 * Result authority (see requirement): `completed` is NEVER synthesized here.
 * It is only echoed from the job layer's terminal record, which the job
 * layer itself only ever marks completed when the delegate runner printed an
 * ok result line AND exited 0 (`src/jobs.ts` computeTerminalRecord). Every
 * output this module constructs itself — schema rejection, mapping/context/
 * vision guards, job-start failure, poll failure, deadline timeout, abort —
 * is status `error` (or `cancelled` via the cancel companion), never
 * `completed`. `finish_reason` from the runner is surfaced verbatim.
 *
 * Ownership notes:
 *  - Write preset: `buildWritePrompt` (src/context.ts) renders the context
 *    packet first; its `prompt` is passed as the mapping `rendered_prompt`
 *    seam. Vision preset: `resolveVisionInput` (src/vision.ts) admits images
 *    against the request cwd, `buildImageContentBlocks` assembles them, a
 *    leading `{ type: 'text', text: prompt }` block preserves text/image
 *    order, and the result is passed as the mapping `content_blocks` seam.
 *    Explore / unrestricted pass the caller prompt verbatim.
 *  - `cwd` resolution against the opencode session directory happens in the
 *    tool wrapper (it owns ToolContext.directory); this core expects an
 *    already-resolved input but re-runs the schema defensively first.
 *  - The audit writer is todo 10. This module only exposes the reserved
 *    `auditPathForJob(jobId)` naming contract so job-backed outputs carry a
 *    stable `audit_path` placeholder.
 *
 * No credentials, no real API calls, no new dependencies.
 */
import { join } from 'node:path'
import { redactSecrets } from '../scripts/runner-lib.ts'
import {
  PRESETS,
  PERMISSION_MODES,
  deepseekDelegateInputSchema,
  deepseekDelegateOutputSchema,
  resolvePresetDefaults,
  type DelegateError,
  type DelegateInput,
  type DelegateJob,
  type DelegateOutput,
  type PermissionMode,
  type Preset,
} from './schema.ts'
import {
  DELEGATE_STATE_ROOT,
  buildBridgeRequestWithMetadata,
  type BuiltBridgeRequest,
} from './preset-map.ts'
import { buildWritePrompt } from './context.ts'
import { buildImageContentBlocks, resolveVisionInput } from './vision.ts'
import type { JobOutputView, JobSpec } from './jobs.ts'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Sync default budget: 10 minutes (mirrors the delegate runner's own default). */
export const DEFAULT_SYNC_TIMEOUT_MS = 600_000

/** Poll cadence while waiting for a terminal job state. */
export const POLL_INTERVAL_MS = 250

/** Concise-result cap for `final_response` (kept small for the model). */
export const FINAL_RESPONSE_MAX_CHARS = 4000

/** Cap for error payload text surfaced to the caller. */
export const ERROR_MESSAGE_MAX_CHARS = 2000

/** Cap for stdout/stderr preview text in the output companion view. */
export const TAIL_PREVIEW_MAX_CHARS = 4000

/** Truncation marker appended whenever content is cut. */
export const TRUNCATION_MARKER = '... [truncated]'

/**
 * Reserved audit-file naming for todo 10: one audit record per job, under
 * the project-owned delegate state root. Todo 10's writer adopts this path
 * so job-backed outputs can point at real files without schema drift.
 */
export function auditPathForJob(jobId: string): string {
  return join(DELEGATE_STATE_ROOT, 'audit', `${jobId}.json`)
}

/* ------------------------------------------------------------------ */
/* Seams (dependency injection for the job boundary)                   */
/* ------------------------------------------------------------------ */

/**
 * The job-boundary seam. The tool wrapper wires the real `JobManager`
 * (`src/jobs.ts`) here; tests wire stubs and never spawn a child.
 */
export interface RunDelegateDeps {
  /** Persist a `running` job record + spawn the detached delegate runner. */
  startJob(spec: JobSpec): Promise<DelegateJob>
  /** Normalized job view (terminal states included) + output tails. */
  readOutput(jobId: string): Promise<JobOutputView>
  /** SIGTERM → SIGKILL ladder against the job's process group. */
  cancelJob(jobId: string): Promise<DelegateJob>
  /** Optional caller cancellation (opencode ToolContext.abort in the wrapper). */
  abortSignal?: AbortSignal
  /** Clock seam (defaults to Date.now). */
  now?(): number
  /** Sleep seam (defaults to a real timer; tests pass a no-op). */
  sleep?(ms: number): Promise<void>
}

/** Structured error payload (mirrors delegateErrorSchema). */
export type DelegateErrorPayload = DelegateError

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.code === 'string' && error.code !== '') return error.code
  return undefined
}

function secretExtraValues(): string[] {
  const key = process.env.DEEPSEEK_API_KEY
  return key === undefined || key === '' ? [] : [key]
}

/** Defense-in-depth redaction (upstream layers redact too; stubs may not). */
function redact(text: string): string {
  return redactSecrets(text, secretExtraValues())
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}${TRUNCATION_MARKER}`
}

function formatIssues(issues: readonly { path: readonly (string | number | symbol)[]; message: string }[]): string {
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

function asOutput(output: DelegateOutput): DelegateOutput {
  const parsed = deepseekDelegateOutputSchema.safeParse(output)
  if (!parsed.success) {
    throw new Error(`internal: delegate output violates the output schema: ${formatIssues(parsed.error.issues)}`)
  }
  return parsed.data
}

/** Always-error redaction+cap applied to an error payload before surfacing. */
function redactedError(code: string, message: string): DelegateError {
  return { code, message: truncate(redact(message), ERROR_MESSAGE_MAX_CHARS) }
}


/** Runtime identity of an attempt: preset + its schema-derived model/mode. */
interface DelegateIdentity {
  preset: Preset
  model: string
  permission_mode: PermissionMode
}

function identityOf(input: DelegateInput): DelegateIdentity {
  const defaults = resolvePresetDefaults(input.preset, input.permission_mode)
  return { preset: input.preset, model: defaults.model, permission_mode: defaults.permission_mode }
}

/**
 * Best-effort identity for an input that failed schema validation: the
 * envelope still needs schema-valid preset/model/permission fields, so we
 * derive them from whatever preset string is present and fail closed to the
 * explore defaults otherwise. The error message carries the real diagnosis.
 */
function fallbackIdentityOf(rawInput: unknown): DelegateIdentity {
  let preset: Preset = 'explore'
  if (isRecord(rawInput) && typeof rawInput.preset === 'string' && (PRESETS as readonly string[]).includes(rawInput.preset)) {
    preset = rawInput.preset as Preset
  }
  let override: PermissionMode | undefined
  if (isRecord(rawInput) && typeof rawInput.permission_mode === 'string' && (PERMISSION_MODES as readonly string[]).includes(rawInput.permission_mode)) {
    override = rawInput.permission_mode as PermissionMode
  }
  const defaults = resolvePresetDefaults(preset, override)
  return { preset, model: defaults.model, permission_mode: defaults.permission_mode }
}

/** Base DelegateOutput view from a persisted job record (running/error/cancelled). */
function recordOutput(record: DelegateJob): DelegateOutput {
  // A completed record carries its full validated result — echo it concisely.
  if (record.result !== undefined) return conciseOutput(record.result)
  const out: DelegateOutput = {
    status: record.status,
    preset: record.preset,
    job_id: record.job_id,
    ...(record.session_id === undefined ? {} : { session_id: record.session_id }),
    model: record.model,
    permission_mode: record.permission_mode,
    audit_path: auditPathForJob(record.job_id),
    ...(record.error === undefined ? {} : { error: redactedError(record.error.code, record.error.message) }),
  }
  return asOutput(out)
}

function runningOutput(record: DelegateJob): DelegateOutput {
  return recordOutput(record) // record.status === 'running' by construction here
}

function errOutput(
  identity: DelegateIdentity,
  error: unknown,
  opts: { jobId?: string; sessionId?: string; fallbackCode: string },
): DelegateOutput {
  const code = codeOf(error) ?? opts.fallbackCode
  const out: DelegateOutput = {
    status: 'error',
    preset: identity.preset,
    ...(opts.jobId === undefined ? {} : { job_id: opts.jobId }),
    ...(opts.sessionId === undefined ? {} : { session_id: opts.sessionId }),
    model: identity.model,
    permission_mode: identity.permission_mode,
    error: redactedError(code, messageOf(error)),
    ...(opts.jobId === undefined ? {} : { audit_path: auditPathForJob(opts.jobId) }),
  }
  return asOutput(out)
}

function errOutputFromCode(
  identity: DelegateIdentity,
  code: string,
  message: string,
  jobId?: string,
): DelegateOutput {
  const out: DelegateOutput = {
    status: 'error',
    preset: identity.preset,
    ...(jobId === undefined ? {} : { job_id: jobId }),
    model: identity.model,
    permission_mode: identity.permission_mode,
    error: redactedError(code, message),
    ...(jobId === undefined ? {} : { audit_path: auditPathForJob(jobId) }),
  }
  return asOutput(out)
}

/**
 * Overlay the reserved audit_path placeholder when a job-backed output does
 * not carry one yet (todo 10's writer adopts auditPathForJob naming).
 */
function withAuditPath(output: DelegateOutput, jobId: string): DelegateOutput {
  if (output.audit_path !== undefined) return output
  return asOutput({ ...output, audit_path: auditPathForJob(jobId) })
}

/**
 * Normalize a terminal (or any) DelegateOutput into the concise caller view:
 * redact + truncate `final_response`, redact + cap error messages, echo
 * everything else — including `finish_reason` — verbatim. Never fabricates a
 * status: `completed` passes through only when the source output says so.
 */
export function conciseOutput(output: DelegateOutput): DelegateOutput {
  switch (output.status) {
    case 'completed': {
      const out: DelegateOutput = {
        status: 'completed',
        preset: output.preset,
        ...(output.job_id === undefined ? {} : { job_id: output.job_id }),
        ...(output.session_id === undefined ? {} : { session_id: output.session_id }),
        model: output.model,
        permission_mode: output.permission_mode,
        ...(output.final_response === undefined
          ? {}
          : { final_response: truncate(redact(output.final_response), FINAL_RESPONSE_MAX_CHARS) }),
        ...(output.finish_reason === undefined ? {} : { finish_reason: output.finish_reason }),
        ...(output.audit_path === undefined ? {} : { audit_path: output.audit_path }),
      }
      return asOutput(out)
    }
    case 'error':
      return asOutput({
        ...output,
        ...(output.error === undefined
          ? {}
          : { error: redactedError(output.error.code, output.error.message) }),
      })
    case 'cancelled':
    case 'running':
      return asOutput({ ...output })
  }
}

/** Capped + redacted stdout/stderr preview for the output companion view. */
function previewTail(tail: string): string {
  return truncate(redact(tail), TAIL_PREVIEW_MAX_CHARS)
}

/* ------------------------------------------------------------------ */
/* Mapping (prompt/blocks per preset)                                  */
/* ------------------------------------------------------------------ */

/**
 * Build the bridge request for a schema-validated input:
 *  - write:        buildWritePrompt renders the packet (or auto-context
 *                  wrapper) → mapping `rendered_prompt` seam.
 *  - vision:       resolveVisionInput (against input.cwd) → image content
 *                  blocks with a leading text block → mapping `content_blocks`
 *                  seam.
 *  - explore/…:    unrestricted → caller prompt verbatim.
 * Throws PresetMappingError / ContextError / VisionInputError — all carry
 * `.code` and are redacted by the caller before surfacing.
 */
function buildMappedRequest(input: DelegateInput): BuiltBridgeRequest {
  switch (input.preset) {
    case 'write': {
      const built = buildWritePrompt({
        packet: input.context_packet,
        rawPrompt: input.prompt,
        allow_auto_context: input.allow_auto_context === true,
      })
      return buildBridgeRequestWithMetadata({ input, rendered_prompt: built.prompt })
    }
    case 'vision': {
      // The schema guarantees >= 1 image for vision; this guard covers a
      // forged object that somehow passed safeParse (defense in depth, same
      // spirit as the mapping layer's own re-checks).
      const imagePaths = input.images
      if (imagePaths === undefined || imagePaths.length === 0) {
        throw new Error('preset "vision" requires at least one image path (schema guarantees this; refusing a prompt-only request)')
      }
      const resolved = resolveVisionInput(imagePaths, input.cwd) // fs admission, absolute paths
      // Leading text block preserves text/image order (the vision adapter
      // expects the instruction alongside the images). Fresh object literals
      // satisfy the mapping's ContentBlockInput index signature.
      const blocks = [
        { type: 'text' as const, text: input.prompt },
        ...buildImageContentBlocks(resolved).map((block) => ({
          type: block.type,
          attachment: block.attachment,
        })),
      ]
      return buildBridgeRequestWithMetadata({ input, resolved_images: resolved, content_blocks: blocks })
    }
    default:
      // explore | unrestricted — caller prompt verbatim.
      return buildBridgeRequestWithMetadata({ input })
  }
}

function jobSpecFrom(built: BuiltBridgeRequest): JobSpec {
  const { request, metadata } = built
  return {
    preset: metadata.preset,
    cwd: metadata.cwd,
    ...(request.session_id === undefined ? {} : { session_id: request.session_id }),
    model: metadata.model,
    permission_mode: metadata.permission_mode,
    runner_request: request as unknown as Record<string, unknown>,
  }
}


/* ------------------------------------------------------------------ */
/* Sync wait                                                           */
/* ------------------------------------------------------------------ */

class DeadlineExceeded extends Error {
  readonly code = 'TIMEOUT'
  constructor(readonly deadlineMs: number) {
    super(`sync delegation exceeded its ${deadlineMs} ms budget`)
    this.name = 'DeadlineExceeded'
  }
}

class DelegateAborted extends Error {
  readonly code = 'ABORTED'
  constructor() {
    super('delegation aborted by the caller')
    this.name = 'DelegateAborted'
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll `readOutput` until the job reaches a terminal state (completed /
 * error / cancelled), every POLL_INTERVAL_MS, honoring the deadline. Read
 * errors propagate to the caller (they become structured error outputs).
 * Resolves with the terminal DelegateOutput. Throws DeadlineExceeded /
 * DelegateAborted.
 */
export async function waitForTerminalOutput(
  jobId: string,
  deps: RunDelegateDeps,
  deadlineMs: number,
): Promise<DelegateOutput> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const deadline = now() + deadlineMs
  for (;;) {
    if (deps.abortSignal?.aborted === true) throw new DelegateAborted()
    if (now() >= deadline) throw new DeadlineExceeded(deadlineMs)
    const view = await deps.readOutput(jobId)
    const status = view.output.status
    if (status === 'completed' || status === 'error' || status === 'cancelled') return view.output
    await sleep(POLL_INTERVAL_MS)
  }
}

/** Cancel best-effort; returns a human note about the outcome. */
async function bestEffortCancel(deps: RunDelegateDeps, jobId: string): Promise<string> {
  try {
    await deps.cancelJob(jobId)
    return 'was cancelled'
  } catch (error) {
    const code = codeOf(error) ?? 'UNKNOWN'
    return `cancel failed (${code}): the job may still be running`
  }
}

/* ------------------------------------------------------------------ */
/* Public core API                                                     */
/* ------------------------------------------------------------------ */

/**
 * Execute one delegation. Validates the input through the full schema
 * (including the superRefine preset matrix), maps it to the exact bridge
 * request, starts a background job, then either returns the `running` record
 * immediately (run_in_background) or waits for a terminal state under the
 * deadline (request.timeout_ms or DEFAULT_SYNC_TIMEOUT_MS), cancelling the
 * job when the deadline or the caller's abort signal fires.
 *
 * Always resolves with a schema-valid DelegateOutput — never throws for
 * caller-controllable failures.
 */
export async function runDelegate(input: DelegateInput, deps: RunDelegateDeps): Promise<DelegateOutput> {
  // 1. Defensive re-validation (the opencode arg shape cannot express the
  //    superRefine preset matrix; enforcement happens HERE).
  const parsed = deepseekDelegateInputSchema.safeParse(input)
  if (!parsed.success) {
    const identity = fallbackIdentityOf(input)
    return errOutputFromCode(
      identity,
      'SCHEMA_INVALID',
      `input violates the deepseek_delegate contract: ${formatIssues(parsed.error.issues)}`,
    )
  }
  const valid = parsed.data
  const identity = identityOf(valid)

  // 2. Prompt/blocks per preset + 3. preset → bridge request mapping.
  let built: BuiltBridgeRequest
  try {
    built = buildMappedRequest(valid)
  } catch (error) {
    return errOutput(identity, error, { fallbackCode: 'PREFLIGHT' })
  }
  const spec = jobSpecFrom(built)

  // 4. run_in_background: start and return the running record immediately.
  if (valid.run_in_background === true) {
    let record: DelegateJob
    try {
      record = await deps.startJob(spec)
    } catch (error) {
      return errOutput(identity, error, { fallbackCode: 'JOB_START_FAILED' })
    }
    return runningOutput(record)
  }

  // 5. Sync: start, then poll until terminal under the deadline.
  let record: DelegateJob
  try {
    record = await deps.startJob(spec)
  } catch (error) {
    return errOutput(identity, error, { fallbackCode: 'JOB_START_FAILED' })
  }
  const jobId = record.job_id
  const deadlineMs = valid.timeout_ms ?? DEFAULT_SYNC_TIMEOUT_MS
  try {
    const terminal = await waitForTerminalOutput(jobId, deps, deadlineMs)
    return withAuditPath(conciseOutput(terminal), jobId)
  } catch (error) {
    if (error instanceof DeadlineExceeded) {
      const note = await bestEffortCancel(deps, jobId)
      return errOutputFromCode(
        identity,
        'TIMEOUT',
        `sync delegation exceeded its ${deadlineMs} ms budget; job ${jobId} ${note}`,
        jobId,
      )
    }
    if (error instanceof DelegateAborted) {
      await bestEffortCancel(deps, jobId)
      return errOutputFromCode(identity, 'ABORTED', `delegation was aborted by the caller; job ${jobId} was cancelled`, jobId)
    }
    return errOutput(identity, error, { jobId, fallbackCode: 'JOB_READ_FAILED' })
  }
}

/** Concise view shape returned by the output companion tool. */
export interface JobQueryView {
  job_id: string
  output: DelegateOutput
  stdout_tail: string
  stderr_tail: string
}

export type JobQueryResult =
  | { ok: true; view: JobQueryView }
  | { ok: false; job_id: string; error: DelegateError }

/**
 * Output companion (deepseek_delegate_output): one normalized snapshot of a
 * background job — running records include progress tails; terminal records
 * return the concise final result. Never throws: job-boundary failures
 * (unknown id, torn file, …) come back as `{ ok: false, error }`.
 */
export async function queryJobOutput(jobId: string, deps: RunDelegateDeps): Promise<JobQueryResult> {
  try {
    const view = await deps.readOutput(jobId)
    return {
      ok: true,
      view: {
        job_id: jobId,
        output: withAuditPath(conciseOutput(view.output), jobId),
        stdout_tail: previewTail(view.stdout_tail),
        stderr_tail: previewTail(view.stderr_tail),
      },
    }
  } catch (error) {
    return { ok: false, job_id: jobId, error: redactedError(codeOf(error) ?? 'JOB_READ_FAILED', messageOf(error)) }
  }
}

export type CancelResult = { ok: true; output: DelegateOutput } | { ok: false; job_id: string; error: DelegateError }

/**
 * Cancel companion (deepseek_delegate_cancel): SIGTERM → SIGKILL ladder via
 * the job layer. Resolves with the terminal record view when the cancel
 * succeeded (status cancelled — or completed/error when the job won the
 * natural-exit race). Never throws.
 */
export async function cancelDelegateJob(jobId: string, deps: RunDelegateDeps): Promise<CancelResult> {
  try {
    const record = await deps.cancelJob(jobId)
    return { ok: true, output: recordOutput(record) }
  } catch (error) {
    return { ok: false, job_id: jobId, error: redactedError(codeOf(error) ?? 'CANCEL_FAILED', messageOf(error)) }
  }
}

/** Render a structured result as the tool's string payload (JSON). */
export function delegateResultText(result: unknown): string {
  return JSON.stringify(result, null, 2)
}
