/**
 * deepseek_delegate schema contracts and preset capability matrix.
 *
 * Four fixed presets (explore / write / vision / unrestricted). Callers can
 * never supply free-form `model`, `provider`, or `permission_mode` strings:
 * the input schema carries no model/provider fields at all, and
 * `permission_mode` is only accepted when it matches the preset's allowed set
 * (enforced by superRefine below). Runtime model ids and permission modes are
 * derived from the preset via `resolvePresetDefaults`.
 */
import { z } from "zod"

/** The exact per-call token required before `unrestricted` may run. */
export const UNRESTRICTED_CONFIRMATION_TOKEN = "I_UNDERSTAND_DSH_DANGER_FULL_ACCESS"

/** Fixed delegation presets. */
export const PRESETS = ["explore", "write", "vision", "unrestricted"] as const
export type Preset = (typeof PRESETS)[number]

/** DSH sandbox file-effect modes (network is outside v1 vocabulary). */
export const PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Models the tool is allowed to compute for a preset. */
export const DELEGATE_MODELS = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"] as const
export type DelegateModel = (typeof DELEGATE_MODELS)[number]

/** Lifecycle statuses shared by delegate results and persisted background jobs. */
export const DELEGATE_STATUSES = ["completed", "error", "cancelled", "running"] as const
export type DelegateStatus = (typeof DELEGATE_STATUSES)[number]

/**
 * Write-mode context packet: a bounded, explicit task contract so DeepSeek
 * implements instead of rediscovering the repository from zero. Only
 * `objective` is required at the schema level; richness checks on write
 * packets happen in the context-packet builder (todo 6) — here, `write` is
 * admissible with either a packet or explicit `allow_auto_context: true`.
 */
export const contextPacketSchema = z.strictObject({
  objective: z.string().min(1, "context packet requires a non-empty objective"),
  repo_summary: z.string().optional(),
  relevant_paths: z.array(z.string()).optional(),
  constraints: z.string().optional(),
  expected_changes: z.string().optional(),
  verification_commands: z.array(z.string()).optional(),
  non_goals: z.string().optional(),
  prior_errors: z.string().optional(),
  known_failures: z.string().optional(),
  user_instructions: z.string().optional(),
  handoff_notes: z.string().optional(),
})
export type ContextPacket = z.infer<typeof contextPacketSchema>

/**
 * Shared structured error payload used by the output and job schemas.
 */
export const delegateErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
})
export type DelegateError = z.infer<typeof delegateErrorSchema>

function issue(
  ctx: { addIssue: (arg: { code: "custom"; path: PropertyKey[]; message: string }) => void },
  path: PropertyKey[],
  message: string,
): void {
  ctx.addIssue({ code: "custom", path, message })
}

/**
 * Capability matrix (preset -> allowed permission_mode / images / context):
 *   explore      : permission_mode undefined|read-only; images forbidden; model fixed internally
 *   write        : permission_mode undefined|workspace-write; images forbidden; requires
 *                  context_packet OR allow_auto_context === true
 *   vision       : images required (>=1); permission_mode undefined|read-only|workspace-write
 *   unrestricted : confirm_unrestricted === UNRESTRICTED_CONFIRMATION_TOKEN; permission_mode
 *                  must be undefined (resolves to danger-full-access); images optional
 */
export const deepseekDelegateInputSchema = z
  .strictObject({
    preset: z.enum(PRESETS),
    prompt: z.string().min(1, "prompt must be a non-empty string"),
    cwd: z.string(),
    session_id: z.string().optional(),
    run_in_background: z.boolean().optional(),
    context_packet: contextPacketSchema.optional(),
    images: z.array(z.string()).min(1).optional(),
    permission_mode: z.enum(PERMISSION_MODES).optional(),
    confirm_unrestricted: z.string().optional(),
    allow_auto_context: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .superRefine((input, ctx) => {
    const { preset, permission_mode, images, context_packet, allow_auto_context, confirm_unrestricted } = input
    switch (preset) {
      case "explore":
        if (permission_mode !== undefined && permission_mode !== "read-only") {
          issue(ctx, ["permission_mode"], `preset "explore" only allows permission_mode "read-only" (got "${permission_mode}")`)
        }
        if (images !== undefined) {
          issue(ctx, ["images"], 'preset "explore" does not accept images')
        }
        break
      case "write":
        if (permission_mode !== undefined && permission_mode !== "workspace-write") {
          issue(ctx, ["permission_mode"], `preset "write" only allows permission_mode "workspace-write" (got "${permission_mode}")`)
        }
        if (images !== undefined) {
          issue(ctx, ["images"], 'preset "write" does not accept images')
        }
        if (context_packet === undefined && allow_auto_context !== true) {
          issue(ctx, ["context_packet"], 'preset "write" requires a context_packet or allow_auto_context: true')
        }
        break
      case "vision":
        if (permission_mode !== undefined && permission_mode === "danger-full-access") {
          issue(ctx, ["permission_mode"], 'preset "vision" only allows permission_mode "read-only" or "workspace-write" (got "danger-full-access")')
        }
        if (images === undefined) {
          issue(ctx, ["images"], 'preset "vision" requires at least one image')
        }
        break
      case "unrestricted":
        if (permission_mode !== undefined) {
          issue(ctx, ["permission_mode"], 'preset "unrestricted" does not accept a caller permission_mode; it resolves to "danger-full-access"')
        }
        if (confirm_unrestricted !== UNRESTRICTED_CONFIRMATION_TOKEN) {
          issue(ctx, ["confirm_unrestricted"], `preset "unrestricted" requires confirm_unrestricted === "${UNRESTRICTED_CONFIRMATION_TOKEN}"`)
        }
        break
    }
  })
export type DelegateInput = z.infer<typeof deepseekDelegateInputSchema>

/**
 * Execute-result payload returned for sync invocations and as the final
 * result of background jobs. `model` is computed (never caller-chosen);
 * `permission_mode` is the resolved mode for the preset.
 */
export const deepseekDelegateOutputSchema = z.strictObject({
  status: z.enum(DELEGATE_STATUSES),
  preset: z.enum(PRESETS),
  job_id: z.string().optional(),
  session_id: z.string().optional(),
  model: z.string(),
  permission_mode: z.enum(PERMISSION_MODES),
  final_response: z.string().optional(),
  finish_reason: z.string().optional(),
  audit_path: z.string().optional(),
  error: delegateErrorSchema.optional(),
})
export type DelegateOutput = z.infer<typeof deepseekDelegateOutputSchema>

/**
 * Persisted metadata for background jobs stored under
 * `.omo/deepseek-delegate/jobs/<job_id>.json`.
 */
export const delegateJobSchema = z.strictObject({
  job_id: z.string().min(1),
  preset: z.enum(PRESETS),
  created_at: z.iso.datetime(),
  cwd: z.string(),
  session_id: z.string().optional(),
  status: z.enum(DELEGATE_STATUSES),
  model: z.string(),
  permission_mode: z.enum(PERMISSION_MODES),
  result: deepseekDelegateOutputSchema.optional(),
  error: delegateErrorSchema.optional(),
  pid: z.number().int().positive().optional(),
})
export type DelegateJob = z.infer<typeof delegateJobSchema>

export interface PresetDefaults {
  model: DelegateModel
  permission_mode: PermissionMode
}

/**
 * Deterministic preset -> runtime defaults:
 *   explore      -> deepseek-v4-flash,            read-only
 *   write        -> deepseek-v4-flash,            workspace-write
 *   vision       -> deepseek-v4-flash-vision-exp, read-only unless the caller
 *                  explicitly overrides with workspace-write
 *   unrestricted -> deepseek-v4-flash,            danger-full-access
 *
 * Overrides outside a preset's allowed set are schema-rejected upstream; this
 * function fails closed (keeps the preset default) if handed one anyway.
 */
export function resolvePresetDefaults(preset: Preset, permissionModeOverride?: PermissionMode): PresetDefaults {
  switch (preset) {
    case "explore":
      return { model: "deepseek-v4-flash", permission_mode: "read-only" }
    case "write":
      return { model: "deepseek-v4-flash", permission_mode: "workspace-write" }
    case "vision": {
      const permission_mode: PermissionMode =
        permissionModeOverride === "workspace-write" ? "workspace-write" : "read-only"
      return { model: "deepseek-v4-flash-vision-exp", permission_mode }
    }
    case "unrestricted":
      return { model: "deepseek-v4-flash", permission_mode: "danger-full-access" }
  }
}
