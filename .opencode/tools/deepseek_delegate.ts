/**
 * deepseek_delegate — opencode custom tool (plan todo 7 wiring).
 *
 * Filename = tool id: the DEFAULT export becomes `deepseek_delegate`; the
 * named `output` / `wait` / `cancel` exports become `deepseek_delegate_output` /
 * `deepseek_delegate_wait` / `deepseek_delegate_cancel` (custom-tool multi-export naming).
 *
 * This file is deliberately a THIN wrapper over the core in
 * `src/delegate-execute.ts` (runDelegate + queryJobOutput +
 * cancelDelegateJob), which owns every rule: defensive schema re-validation
 * (the arg SHAPE cannot express the superRefine preset matrix — the execute
 * path re-parses the full schema), preset body construction, bridge request
 * mapping, background-vs-sync branching, deadline handling, and structured
 * result normalization. Keeping the core free of `@opencode-ai/plugin`
 * imports means tests stub the job boundary without touching a real API.
 *
 * Context duties owned here (core has no ToolContext):
 *   - resolve a RELATIVE `cwd` against `context.directory`;
 *   - surface the attempt via `context.metadata` (title + preset/model) so
 *     opencode shows UI activity for the call.
 *
 * v1 caveat (must be visible to every caller): explore/write/vision confine
 * FILE effects through the DSH sandbox policy, but nothing hard-blocks
 * NETWORK access in v1.
 */
import { tool } from '@opencode-ai/plugin'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import {
  cancelDelegateJob,
  delegateResultText,
  queryJobOutput,
  runDelegate,
  waitForJobOutput,
  type RunDelegateDeps,
} from '../../src/delegate-execute.ts'
import { writeAuditFromResult } from '../../src/audit.ts'
import {
  PRESETS,
  PERMISSION_MODES,
  deepseekDelegateInputSchema,
  resolvePresetDefaults,
  type PermissionMode,
  type Preset,
} from '../../src/schema.ts'

import { JobManager } from '../../src/jobs.ts'

/* ------------------------------------------------------------------ */
/* Live job-boundary wiring (lazy singleton; nothing spawns at import) */
/* ------------------------------------------------------------------ */

let manager: JobManager | undefined

function liveManager(): JobManager {
  manager ??= new JobManager()
  return manager
}

function liveDeps(abortSignal: AbortSignal): RunDelegateDeps {
  const jobs = liveManager()
  return {
    startJob: (spec) => jobs.start(spec),
    readOutput: (jobId) => jobs.output(jobId),
    cancelJob: (jobId) => jobs.cancel(jobId),
    abortSignal,
  }
}

/** Best-effort preset/mode derivation for metadata (input may be invalid). */
function guessPreset(raw: Record<string, unknown>): Preset | undefined {
  if (typeof raw.preset === 'string' && (PRESETS as readonly string[]).includes(raw.preset)) {
    return raw.preset as Preset
  }
  return undefined
}

function guessMode(raw: Record<string, unknown>): PermissionMode | undefined {
  if (typeof raw.permission_mode === 'string' && (PERMISSION_MODES as readonly string[]).includes(raw.permission_mode)) {
    return raw.permission_mode as PermissionMode
  }
  return undefined
}

/**
 * Requirement 7: a RELATIVE cwd resolves against the opencode session
 * directory (context.directory); an absolute cwd is used as-is.
 */
function resolveCwd(cwd: string, sessionDirectory: string): string {
  return isAbsolute(cwd) ? cwd : resolve(sessionDirectory, cwd)
}

/* ------------------------------------------------------------------ */
/* Default export: deepseek_delegate                                   */
/* ------------------------------------------------------------------ */

/** v1 network caveat shown on every tool surface (audit + descriptions). */
const NETWORK_CAVEAT_V1 =
  'CAVEAT v1: file effects are confined for explore/write/vision, but v1 does NOT ' +
  'hard-block network access from the delegated agent — review results accordingly.'

const delegateDescription =
  'Delegate one bounded task to a DeepSeek model through the DeepSeek Harness runtime. ' +
  'Presets: "explore" (read-only repository analysis, deepseek-v4-flash), "write" ' +
  '(workspace-write implementation; requires a context_packet or allow_auto_context:true), ' +
  '"vision" (image-aware; needs images, deepseek-v4-flash-vision-exp, read-only unless ' +
  'permission_mode:"workspace-write"), "unrestricted" (danger-full-access; requires ' +
  'confirm_unrestricted === "I_UNDERSTAND_DSH_DANGER_FULL_ACCESS"). ' +
  'Set run_in_background:true to get a bg_ job id immediately, wait once with ' +
  'deepseek_delegate_wait, inspect progress with deepseek_delegate_output, and stop with deepseek_delegate_cancel. ' +
  'Returns structured JSON: status/preset/model/permission_mode/job_id/session_id/' +
  'finish_reason/final_response/audit_path/error. ' +
  NETWORK_CAVEAT_V1
const delegateTool = tool({
  description: delegateDescription,
  args: deepseekDelegateInputSchema.shape,
  execute: async (args, context) => {
    try {
      // Best-effort UI activity metadata (title + preset/model) before any work.
      const raw = args as unknown as Record<string, unknown>
      const preset = guessPreset(raw)
      const defaults = resolvePresetDefaults(preset ?? 'explore', guessMode(raw))
      context.metadata({
        title: `deepseek_delegate · ${preset ?? 'invalid-input'} · ${defaults.model}`,
        metadata: {
          preset,
          model: defaults.model,
          permission_mode: defaults.permission_mode,
        },
      })
      const cwd = resolveCwd(args.cwd, context.directory)
      // The core re-validates through the full schema (superRefine matrix) —
      // enforcement of cross-field rules happens there, not at arg-shape time.
      const startedAt = new Date()
      const input = { ...args, cwd }
      const result = await runDelegate(input, liveDeps(context.abort))
      // Audit ledger (todo 10): ONE metadata record per invocation — success
      // AND failure, written after the run resolves so preflight rejections
      // are recorded too. Best-effort: a failed audit write (null) never
      // alters the result. On success the returned audit_path points at the
      // REAL written file (job-backed outputs already carried the reserved
      // placeholder for this exact path).
      const auditPath = writeAuditFromResult({ input, output: result, startedAt })
      return delegateResultText(auditPath === null ? result : { ...result, audit_path: auditPath })
    } catch (error) {
      // Last-resort guard: the core never throws for caller-controllable
      // failures, so reaching here is an internal invariant break.
      return delegateResultText({
        status: 'error',
        preset: 'explore',
        model: 'deepseek-v4-flash',
        permission_mode: 'read-only',
        error: {
          code: 'INTERNAL',
          message: `deepseek_delegate execute failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        },
      })
    }
  },
})

export default delegateTool

/* ------------------------------------------------------------------ */
/* Named export: deepseek_delegate_output                              */
/* ------------------------------------------------------------------ */

const jobIdDescription =
  'job_id of a background deepseek_delegate run — the bg_<hex> id returned in ' +
  '"job_id" when run_in_background was true.'

const outputTool = tool({
  description:
    'Read one background deepseek_delegate job snapshot: running jobs include ' +
    'redacted stdout/stderr progress tails; terminal jobs return the final structured ' +
    'result (status/session_id/finish_reason/final_response). ' +
    'Returns {"ok":true,"view":{...}} on success or {"ok":false,"error":{code,message}}. ' +
    NETWORK_CAVEAT_V1,
  args: { job_id: z.string().min(1, 'job_id is required (bg_<hex> from deepseek_delegate)') },
  execute: async (args, context) => {
    context.metadata({ title: `deepseek_delegate_output · ${args.job_id}` })
    const result = await queryJobOutput(args.job_id, liveDeps(context.abort))
    return delegateResultText(result)
  },
})

export const output = outputTool

/* ------------------------------------------------------------------ */
/* Named export: deepseek_delegate_wait                                */
/* ------------------------------------------------------------------ */

const waitTool = tool({
  description:
    'Wait for one background deepseek_delegate job to reach a terminal state. ' +
    'This is the low-polling continuation path: start with run_in_background:true, ' +
    'then call this once instead of repeatedly polling deepseek_delegate_output. ' +
    'Timeout ends the wait but leaves the background job running. ' +
    'Returns the same shape as deepseek_delegate_output. ' +
    NETWORK_CAVEAT_V1,
  args: {
    job_id: z.string().min(1, 'job_id is required (bg_<hex> from deepseek_delegate)'),
    timeout_ms: z.number().int().positive().optional(),
  },
  execute: async (args, context) => {
    context.metadata({ title: `deepseek_delegate_wait · ${args.job_id}` })
    const result = await waitForJobOutput(args.job_id, liveDeps(context.abort), args.timeout_ms)
    return delegateResultText(result)
  },
})

export const wait = waitTool

/* ------------------------------------------------------------------ */
/* Named export: deepseek_delegate_cancel                              */
/* ------------------------------------------------------------------ */

const cancelTool = tool({
  description:
    'Cancel a running background deepseek_delegate job (SIGTERM then SIGKILL to the ' +
    'job process group). Returns {"ok":true,"output":{status:"cancelled",...}} on ' +
    'success or {"ok":false,"error":{code,message}} (e.g. JOB_NOT_RUNNING for a ' +
    'terminal job). ' +
    NETWORK_CAVEAT_V1,
  args: { job_id: z.string().min(1, 'job_id is required (bg_<hex> from deepseek_delegate)') },
  execute: async (args, context) => {
    context.metadata({ title: `deepseek_delegate_cancel · ${args.job_id}` })
    const result = await cancelDelegateJob(args.job_id, liveDeps(context.abort))
    return delegateResultText(result)
  },
})

export const cancel = cancelTool
