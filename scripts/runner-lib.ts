/**
 * Pure logic for the DeepSeek Harness delegate bridge (`scripts/delegate-runner.ts`).
 *
 * Kept free of side effects and free of non-node imports so unit tests can
 * import it directly. The executable entry lives in `delegate-runner.ts`; this
 * module exports the allowlist, env scrubber, finish-reason derivation, request
 * parsing, runtime-bin resolution, and credential-shaped text redaction.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ */
/* Env allowlist                                                       */
/* ------------------------------------------------------------------ */

/**
 * The ONLY environment variables the DSH runtime subprocess receives.
 *
 * The SDK spawns the runtime with the provided env object, REPLACING the
 * parent environment entirely — nothing from the opencode process leaks into
 * the child unless it is listed here.
 *
 * Copy-if-set from the parent (only when present there):
 *  - `PATH`                     — spawn needs it to find the `node` binary
 *  - `HOME`
 *  - `DEEPSEEK_API_KEY`         — provider credential (never read from argv)
 *  - `DEEPSEEK_BASE_URL`        — optional provider endpoint override
 *
 * Always assigned from the bridge request:
 *  - `DSH_SESSION_ROOT`         — directory for DSH session logs
 *  - `DSH_CORDIS_CONFIG`        — absolute path to the runtime cordis.yml
 *  - `DSH_CWD`                  — workspace cwd recorded by the runtime
 *  - `DSH_PERMISSION_MODE`      — per-call file-effect mode ('read-only' |
 *                                 'workspace-write' | 'danger-full-access')
 *
 * Every other parent variable (ambient `DSH_*`, `NODE_OPTIONS`, unrelated
 * cloud/LLM secrets, ...) is DROPPED.
 */
export const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DSH_SESSION_ROOT',
  'DSH_CORDIS_CONFIG',
  'DSH_CWD',
  'DSH_PERMISSION_MODE',
] as const

export type AllowlistedEnvKey = (typeof ENV_ALLOWLIST)[number]

/** Values the scrubber forces into the child env from the bridge request. */
export interface ScrubEnvInputs {
  /** Value for `DSH_SESSION_ROOT` (session-log directory). */
  sessionRoot: string
  /** Value for `DSH_CORDIS_CONFIG` (absolute cordis.yml path). */
  cordisConfig: string
  /** Value for `DSH_CWD` (absolute workspace directory). */
  cwd: string
  /** Value for `DSH_PERMISSION_MODE` (per-call file-effect mode). */
  permissionMode: string
}

/**
 * Build the child environment for the DSH runtime subprocess.
 *
 * Starts from an EMPTY object and copies only allowlisted keys — secrets and
 * ambient `DSH_*` noise in the parent never cross over.
 *
 * @param parent - the bridge process environment (or any parent-env stand-in).
 * @param inputs - request-derived values forced into the allowlisted slots.
 * @returns a fresh object whose keys are exactly the allowlist (minus any
 *   copy-if-set keys absent from the parent).
 */
export function scrubEnv(
  parent: Readonly<Record<string, string | undefined>> | undefined,
  inputs: ScrubEnvInputs,
): Record<string, string> {
  const source = parent ?? {}
  const out: Record<string, string> = {}
  if (source.PATH !== undefined) out.PATH = source.PATH
  if (source.HOME !== undefined) out.HOME = source.HOME
  if (source.DEEPSEEK_API_KEY !== undefined) out.DEEPSEEK_API_KEY = source.DEEPSEEK_API_KEY
  if (source.DEEPSEEK_BASE_URL !== undefined) out.DEEPSEEK_BASE_URL = source.DEEPSEEK_BASE_URL
  out.DSH_SESSION_ROOT = inputs.sessionRoot
  out.DSH_CORDIS_CONFIG = inputs.cordisConfig
  out.DSH_CWD = inputs.cwd
  out.DSH_PERMISSION_MODE = inputs.permissionMode
  return out
}

/* ------------------------------------------------------------------ */
/* Finish-reason derivation                                            */
/* ------------------------------------------------------------------ */

/**
 * Derive the run's finish reason from the last `turn/end` session event.
 *
 * Wire shape (`@deepseek-ai/dsh-session`): `{ type: 'turn/end', data: {
 * turn, reason: { kind: ... } } }`. Kinds include `completed`, `max-tokens`,
 * `error`, `aborted`, `blocked`, `interrupted`. When no `turn/end` event is
 * present (or it carries no reason), returns `'unknown'` — we never fabricate
 * a `completed`.
 *
 * @param events - `RunResult.events` (root-session `session.event` payloads).
 * @returns the last turn's reason kind, else `'unknown'`.
 */
export function deriveFinishReason(events: readonly unknown[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!isRecord(event) || event.type !== 'turn/end') continue
    const data = isRecord(event.data) ? event.data : undefined
    const reason =
      (data !== undefined && isRecord(data.reason) && data.reason) ||
      (isRecord(event.reason) ? event.reason : undefined)
    if (reason !== undefined && typeof reason.kind === 'string') return reason.kind
    return 'unknown'
  }
  return 'unknown'
}

/* ------------------------------------------------------------------ */
/* Request model                                                       */
/* ------------------------------------------------------------------ */

/** One bridge request, normalized (camelCase fields per the bridge contract). */
export interface DelegateRequest {
  /** Reuse a DSH session id for follow-up turns; omitted mints a fresh one. */
  session_id?: string
  /** Text prompt. Mutually exclusive with {@link content_blocks}. */
  prompt?: string
  /** Verbatim content blocks. Mutually exclusive with {@link prompt}. */
  content_blocks?: unknown[]
  /** Workspace directory the agent runs in. */
  cwd: string
  /** Provider route; default `deepseek-official`. */
  provider: string
  /** Model id; default `deepseek-v4-flash`. */
  model: string
  /** Optional output-token cap. */
  max_tokens?: number
  /** Optional overall run budget in ms. */
  timeout_ms?: number
  /** Directory for DSH session logs. */
  session_root: string
  /** Absolute path to the runtime cordis.yml. */
  cordis_config: string
  /** Per-call file-effect mode; default `read-only`. */
  permission_mode: PermissionMode
}

export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-v4-flash'
export const DEFAULT_PERMISSION_MODE = 'read-only'

/** File-effect permission modes the runtime sandbox policy accepts. */
export const PERMISSION_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Marker for structured bridge errors; `code` flows into the wire error payload. */
export class BridgeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/** Input contract violation (bad JSON, missing/wrong fields). Exit class: preflight (2). */
export class RequestParseError extends BridgeError {
  constructor(message: string) {
    super('BAD_REQUEST', message)
    this.name = 'RequestParseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RequestParseError(`request field "${field}" must be a non-empty string`)
  }
  return value
}

function optionalPositiveInteger(raw: Record<string, unknown>, field: string): number | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RequestParseError(`request field "${field}" must be a positive integer when present`)
  }
  return value
}

/**
 * Validate and normalize a raw request object (parsed from JSON).
 *
 * Required: `cwd`, `session_root`, `cordis_config` and exactly one of
 * `prompt` / `content_blocks`. Optional: `session_id`, `max_tokens`,
 * `timeout_ms`, `permission_mode` (default `read-only`). `provider` and
 * `model` default per the bridge contract.
 */
export function parseRequest(rawValue: unknown): DelegateRequest {
  if (!isRecord(rawValue)) {
    throw new RequestParseError('request must be a JSON object')
  }
  const hasPrompt = rawValue.prompt !== undefined
  const hasBlocks = rawValue.content_blocks !== undefined
  if (hasPrompt === hasBlocks) {
    throw new RequestParseError('request must provide exactly one of "prompt" (string) or "content_blocks" (array)')
  }
  if (hasPrompt && typeof rawValue.prompt !== 'string') {
    throw new RequestParseError('request field "prompt" must be a string')
  }
  if (hasBlocks) {
    const blocks = rawValue.content_blocks
    if (!Array.isArray(blocks) || blocks.length === 0 || !blocks.every((b) => isRecord(b) && typeof b.type === 'string')) {
      throw new RequestParseError('request field "content_blocks" must be a non-empty array of { type, ... } blocks')
    }
  }
  const sessionId = rawValue.session_id
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId === '')) {
    throw new RequestParseError('request field "session_id" must be a non-empty string when present')
  }
  const provider = rawValue.provider
  if (provider !== undefined && (typeof provider !== 'string' || provider === '')) {
    throw new RequestParseError('request field "provider" must be a non-empty string when present')
  }
  const model = rawValue.model
  if (model !== undefined && (typeof model !== 'string' || model === '')) {
    throw new RequestParseError('request field "model" must be a non-empty string when present')
  }
  const permissionMode = rawValue.permission_mode
  if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode as PermissionMode)) {
    throw new RequestParseError(
      `request field "permission_mode" must be one of: ${PERMISSION_MODES.join(', ')}`,
    )
  }
  return {
    session_id: sessionId as string | undefined,
    prompt: hasPrompt ? (rawValue.prompt as string) : undefined,
    content_blocks: hasBlocks ? (rawValue.content_blocks as unknown[]) : undefined,
    cwd: requiredString(rawValue, 'cwd'),
    provider: (provider as string | undefined) ?? DEFAULT_PROVIDER,
    model: (model as string | undefined) ?? DEFAULT_MODEL,
    max_tokens: optionalPositiveInteger(rawValue, 'max_tokens'),
    timeout_ms: optionalPositiveInteger(rawValue, 'timeout_ms'),
    session_root: requiredString(rawValue, 'session_root'),
    cordis_config: requiredString(rawValue, 'cordis_config'),
    permission_mode: (permissionMode as PermissionMode | undefined) ?? DEFAULT_PERMISSION_MODE,
  }
}

/** Parse one JSON request string (from argv `--request` or a single stdin line). */
export function parseRequestJson(jsonText: string): DelegateRequest {
  const trimmed = jsonText.trim()
  if (trimmed === '') {
    throw new RequestParseError('empty request: pass --request <json> or one JSON line on stdin')
  }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new RequestParseError(`request is not valid JSON: ${detail}`)
  }
  return parseRequest(raw)
}

/** Extract the `--request <json>` (or `--request=<json>`) value from argv. */
export function requestJsonFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--request') {
      const value = argv[index + 1]
      if (value === undefined) throw new RequestParseError('--request requires a JSON string value')
      return value
    }
    if (arg.startsWith('--request=')) return arg.slice('--request='.length)
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Runtime-bin resolution                                              */
/* ------------------------------------------------------------------ */

/** Published package that owns the `dsh-jsonrpc-agent` runtime bin. */
export const DSH_RUNTIME_PACKAGE = '@deepseek-ai/dsh-sdk-jsonrpc-demo'
/** Physical install layout: `<repo-root>/node_modules/<pkg>/lib/bin.js`. */
export const DSH_RUNTIME_BIN_RELPATH = join('node_modules', DSH_RUNTIME_PACKAGE, 'lib', 'bin.js')
/** Export-map subpath used by the `import.meta.resolve` fallback. */
export const DSH_RUNTIME_EXPORT_SPEC = `${DSH_RUNTIME_PACKAGE}/bin`
/** Parent-env override for the runtime bin location. */
export const DSH_RUNTIME_ENV_OVERRIDE = 'DSH_RUNTIME_BIN'

/** Runtime bin could not be located. Exit class: preflight (2). */
export class RuntimeBinNotFoundError extends BridgeError {
  constructor(message: string) {
    super('PREFLIGHT', message)
    this.name = 'RuntimeBinNotFoundError'
  }
}

/**
 * Resolve the DSH JSON-RPC runtime entry (`lib/bin.js` of the demo package).
 *
 * Order:
 *  1. `DSH_RUNTIME_BIN` env override (must point at an existing file).
 *  2. Physical-path search upward from {@link fromDir} for
 *     `node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js`.
 *  3. Best-effort `import.meta.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')`
 *     (the package's exported subpath; `lib/bin.js` itself is not exported),
 *     falling back to `createRequire(...).resolve`.
 *
 * @throws RuntimeBinNotFoundError when no strategy yields an existing file.
 */
export function resolveRuntimeBin(override: string | undefined, fromDir: string): string {
  if (override !== undefined && override !== '') {
    const candidate = isAbsolute(override) ? override : join(process.cwd(), override)
    if (existsSync(candidate)) return candidate
    throw new RuntimeBinNotFoundError(
      `${DSH_RUNTIME_ENV_OVERRIDE} is set to "${override}" but no such file exists`,
    )
  }
  const foundUpward = findUp(fromDir, DSH_RUNTIME_BIN_RELPATH)
  if (foundUpward !== undefined) return foundUpward
  const viaMeta = bestEffortResolve(DSH_RUNTIME_EXPORT_SPEC)
  if (viaMeta !== undefined) return viaMeta
  throw new RuntimeBinNotFoundError(
    `could not locate the DSH runtime bin: install ${DSH_RUNTIME_PACKAGE} (node_modules/${DSH_RUNTIME_PACKAGE}/lib/bin.js) or set ${DSH_RUNTIME_ENV_OVERRIDE}`,
  )
}

function findUp(startDir: string, relPath: string): string | undefined {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, relPath)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function bestEffortResolve(spec: string): string | undefined {
  const meta = import.meta as ImportMeta & { resolve?: (s: string) => string | URL }
  if (typeof meta.resolve === 'function') {
    try {
      const resolved = meta.resolve(spec)
      return typeof resolved === 'string' ? resolved : fileURLToPath(resolved)
    } catch {
      // fall through to createRequire
    }
  }
  try {
    return createRequire(import.meta.url).resolve(spec)
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* Credential-shaped text redaction                                    */
/* ------------------------------------------------------------------ */

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|secret|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
]

/**
 * Redact credential-shaped substrings from diagnostic text.
 *
 * @param text - arbitrary diagnostic/error/response text.
 * @param extraValues - literal secrets to replace wholesale (e.g. the active
 *   `DEEPSEEK_API_KEY` value).
 * @returns the text with every credential-shaped match replaced by `[REDACTED]`.
 */
export function redactSecrets(text: string, extraValues: readonly string[] = []): string {
  let out = text
  for (const literal of extraValues) {
    if (literal !== '' && out.includes(literal)) out = out.split(literal).join('[REDACTED]')
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]')
  }
  return out
}
