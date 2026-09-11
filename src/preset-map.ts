/**
 * Deterministic preset → DSH bridge request mapping (plan todo 5).
 *
 * Turns a schema-validated {@link DelegateInput} into the exact
 * {@link DelegateRequest} the delegate bridge (`scripts/delegate-runner.ts`)
 * accepts, plus metadata the tool execute path (todo 7) and audit path
 * (todo 10) consume.
 *
 * Ownership boundaries (what lives here vs. adjacent todos):
 *  - Model + permission_mode come EXCLUSIVELY from `resolvePresetDefaults`
 *    (src/schema.ts, todo 2). This module never reads a `model`/`provider`
 *    key off the input — a forged field cannot exist on the typed input, and
 *    even a forged runtime object is ignored because those keys are never
 *    consulted.
 *  - Caller permission overrides are schema-gated upstream; when one still
 *    arrives here (bypassing safeParse), `resolvePresetDefaults` fails closed
 *    to the preset default and the mapping honors that derived value.
 *  - The write context packet is rendered into prompt text by the todo-6
 *    builder. This module only maps the packet's *presence*
 *    (`metadata.has_context_packet`) and accepts the rendered text via
 *    `BuildBridgeRequestInput.rendered_prompt` — it never renders packets.
 *  - The vision preset is DISABLED (DeepSeek merged the image model into
 *    deepseek-flash): a forged vision input is rejected here with
 *    `VISION_PRESET_DISABLED`, and `content_blocks` is rejected on every live
 *    preset so no image body can slip through as a prompt-only request.
 *  - The custom tool execute path is todo 7; nothing here spawns processes
 *    or touches the filesystem (path checks are the runner's preflight job).
 *
 * No real API calls, no credentials, no new dependencies.
 */
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_PROVIDER, type DelegateRequest } from "../scripts/runner-lib.ts"
import {
  UNRESTRICTED_CONFIRMATION_TOKEN,
  VISION_PRESET_DEPRECATED_MESSAGE,
  resolvePresetDefaults,
  type DelegateInput,
  type DelegateModel,
  type PermissionMode,
  type Preset,
} from "./schema.ts"

/* ------------------------------------------------------------------ */
/* Project-owned paths (resolved from this module's real location)     */
/* ------------------------------------------------------------------ */

/**
 * Composition asset names. `vision` was removed with the model merge; the
 * deprecated dsh/cordis/vision.cordis.yml file is retained but unmounted.
 */
export const CORDIS_COMPOSITIONS = ["base"] as const
export type CordisComposition = (typeof CORDIS_COMPOSITIONS)[number]

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** Project root of THIS tool (the repo owning `.omo` state) — never the delegation target. */
export const PROJECT_ROOT = resolve(MODULE_DIR, "..")

/** Project-owned delegate state root (sessions live under it; audit/jobs join it in todo 10). */
export const DELEGATE_STATE_ROOT = join(PROJECT_ROOT, ".omo", "deepseek-delegate")

/**
 * Session-log root for every delegated run.
 *
 * Deliberately NOT derived from the request `cwd`: `.omo` state is owned by
 * the tool's own project, and delegations may target other repositories.
 * Deriving `session_root` under a foreign target repo would scatter
 * `.omo/deepseek-delegate` state into places this tool does not own, and a
 * relative `cwd` would make session locations unstable. All runs — any
 * preset, any target cwd — share this one project-owned root; the delegate
 * bridge mkdirs it as needed.
 */
export const SESSION_ROOT = join(DELEGATE_STATE_ROOT, "sessions")

/** Project-owned Cordis composition directory (`dsh/cordis/` under the project root). */
export const CORDIS_CONFIG_DIR = join(PROJECT_ROOT, "dsh", "cordis")

/** Absolute cordis.yml per composition. */
export const CORDIS_CONFIG_PATH: Record<CordisComposition, string> = {
  base: join(CORDIS_CONFIG_DIR, "base.cordis.yml"),
}

/** Every live preset mounts the base (sandboxed) composition; vision is rejected before mapping. */
const COMPOSITION_BY_PRESET: Record<Preset, CordisComposition> = {
  explore: "base",
  write: "base",
  vision: "base", // unreachable: the guard in buildBridgeRequestWithMetadata rejects vision first
  unrestricted: "base",
}

/* ------------------------------------------------------------------ */
/* Mapping error + public contracts                                    */
/* ------------------------------------------------------------------ */

/**
 * A preflight-class mapping failure. Raised BEFORE any helper/runner spawn;
 * the tool execute path (todo 7) maps `code` straight into the structured
 * output `error.code`.
 */
export class PresetMappingError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "PresetMappingError"
    this.code = code
  }
}

/**
 * @deprecated The vision preset is disabled (image model merged into
 * deepseek-flash). Retained only so stale callers passing
 * `resolved_images` keep type-checking; metadata records declared image
 * PATHS for the audit ledger, never image contents.
 */
export interface VisionImage {
  path: string
}

/**
 * Structural contract used ONLY to reject a stale `content_blocks` payload:
 * content blocks were the vision path, which was removed. Every live preset
 * takes a prompt.
 */
export interface ContentBlockInput {
  type: string
  [key: string]: unknown
}

/**
 * Everything the tool execute path (todo 7) hands the mapping: the validated
 * input plus the write preset's rendered prompt.
 *  - `rendered_prompt`: todo 6 renders a write `context_packet` into this.
 *    When absent the caller's raw `input.prompt` is used verbatim.
 *  - `resolved_images` / `content_blocks`: retained for stale callers only.
 *    The vision mapping no longer exists, so any `content_blocks` payload is
 *    rejected (`BLOCKS_ON_TEXT_PRESET`) and `resolved_images` only feeds the
 *    declared-image-paths metadata.
 *
 * A mapped request body is always exactly one `prompt`.
 */
export interface BuildBridgeRequestInput {
  /** Schema-validated delegate input (caller ran `deepseekDelegateInputSchema.safeParse`). */
  input: DelegateInput
  /**
   * Rendered prompt text (todo 6). Falls back to `input.prompt`. Never
   * combine with `content_blocks`.
   */
  rendered_prompt?: string
  /** Images that passed todo-9 admission, mirroring `input.images` as absolute paths. */
  resolved_images?: readonly VisionImage[]
  /**
   * Retained only to REJECT stale payloads: content blocks were the vision
   * path, which is removed (model merge). Any value here fails the mapping.
   */
  content_blocks?: readonly ContentBlockInput[]
}

/** Runtime facts the tool execute path (todo 7) and audit (todo 10) reuse. */
export interface BridgeMappingMetadata {
  /** Preset the request was mapped from. */
  preset: Preset
  /** Derived model id (schema capability matrix; never caller text). */
  model: DelegateModel
  /** Derived file-effect mode (schema capability matrix; exactly one of the three modes). */
  permission_mode: PermissionMode
  /** Composition asset mounted for this preset. */
  composition: CordisComposition
  /** Target workspace directory, resolved absolute. */
  cwd: string
  /** Project-owned session-log root (never derived from `cwd`). */
  session_root: string
  /** Absolute cordis.yml path the runtime boots with. */
  cordis_config: string
  /** True when the write preset carried a `context_packet` (todo 6 must render it). */
  has_context_packet: boolean
  /** Always false: content blocks were the removed vision path (kept so metadata consumers stay stable). */
  uses_content_blocks: boolean
  /** Image paths declared for this call (admission output when present, else the raw input). */
  image_paths: readonly string[]
}

/** Mapping result: the exact bridge request + metadata for the tool/audit paths. */
export interface BuiltBridgeRequest {
  request: DelegateRequest
  metadata: BridgeMappingMetadata
}

/* ------------------------------------------------------------------ */
/* Body resolution                                                     */
/* ------------------------------------------------------------------ */

function isBlock(value: unknown): value is ContentBlockInput {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string"
}

function declaredImagePaths(build: BuildBridgeRequestInput): readonly string[] {
  const admitted = build.resolved_images
  if (admitted !== undefined) return admitted.map((image) => image.path)
  const raw = build.input.images
  return raw === undefined ? [] : raw
}

/**
 * Resolve the request body. Rules (fail closed, deterministic order):
 *  - `content_blocks` malformed (non-array / empty / bad row)  → error
 *  - `content_blocks` on any live preset                       → error
 *    (the vision content-block path was removed with the model merge)
 *  - otherwise prompt = `rendered_prompt` ?? `input.prompt`.
 */
function resolveBody(build: BuildBridgeRequestInput): { prompt: string; uses_content_blocks: false } {
  const blocks = build.content_blocks
  if (blocks !== undefined) {
    if (!Array.isArray(blocks) || blocks.length === 0 || !blocks.every(isBlock)) {
      throw new PresetMappingError(
        "INVALID_CONTENT_BLOCKS",
        "content_blocks must be a non-empty array of { type: string, ... } records (the wire contract the bridge validates)",
      )
    }
    throw new PresetMappingError(
      "BLOCKS_ON_TEXT_PRESET",
      `preset "${build.input.preset}" takes a prompt, not content_blocks; the vision preset (the only content-block route) was removed when the image model merged into deepseek-flash`,
    )
  }

  return { prompt: build.rendered_prompt ?? build.input.prompt, uses_content_blocks: false }
}

/* ------------------------------------------------------------------ */
/* Public mapping API                                                  */
/* ------------------------------------------------------------------ */

/**
 * Map a validated input to the exact bridge request (see module docs for the
 * full rule table). Throws {@link PresetMappingError} on mapping-layer
 * contract violations — always before any runner/helper invocation.
 */
export function buildBridgeRequestWithMetadata(build: BuildBridgeRequestInput): BuiltBridgeRequest {
  const { input } = build
  const preset = input.preset

  // Last gate before the runner: the input TYPE makes confirm_unrestricted
  // optional, so a caller that constructs DelegateInput without going through
  // safeParse could otherwise reach danger-full-access ungated. The schema
  // test asserts the safeParse rejection; this guard asserts the same
  // property at the mapping boundary (layered, not duplicated).
  if (preset === "unrestricted" && input.confirm_unrestricted !== UNRESTRICTED_CONFIRMATION_TOKEN) {
    throw new PresetMappingError(
      "UNRESTRICTED_CONFIRMATION_REQUIRED",
      `preset "unrestricted" requires confirm_unrestricted === "${UNRESTRICTED_CONFIRMATION_TOKEN}" before mapping to danger-full-access`,
    )
  }

  // The vision preset is disabled: reject before any model/permission
  // mapping, so a forged input can never select a model or mount a composition.
  if (preset === "vision") {
    throw new PresetMappingError("VISION_PRESET_DISABLED", VISION_PRESET_DEPRECATED_MESSAGE)
  }

  // Model + permission_mode are derived exclusively from the schema's
  // capability matrix; resolvePresetDefaults fails closed on stray overrides.
  const defaults = resolvePresetDefaults(preset, input.permission_mode)
  const composition = COMPOSITION_BY_PRESET[preset]
  const body = resolveBody(build)
  const cwd = resolve(input.cwd)
  const cordisConfig = CORDIS_CONFIG_PATH[composition]

  const request: DelegateRequest = {
    cwd,
    provider: DEFAULT_PROVIDER,
    model: defaults.model,
    permission_mode: defaults.permission_mode,
    session_root: SESSION_ROOT,
    cordis_config: cordisConfig,
    prompt: body.prompt,
    ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
    ...(input.max_tokens === undefined ? {} : { max_tokens: input.max_tokens }),
    ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
  }

  const metadata: BridgeMappingMetadata = {
    preset,
    model: defaults.model,
    permission_mode: defaults.permission_mode,
    composition,
    cwd,
    session_root: SESSION_ROOT,
    cordis_config: cordisConfig,
    has_context_packet: preset === "write" && input.context_packet !== undefined,
    uses_content_blocks: body.uses_content_blocks,
    image_paths: declaredImagePaths(build),
  }

  return { request, metadata }
}

/** Map a validated input to the exact bridge request (discards metadata). */
export function buildBridgeRequest(build: BuildBridgeRequestInput): DelegateRequest {
  return buildBridgeRequestWithMetadata(build).request
}
