/**
 * Audit ledger for deepseek_delegate (plan todo 10).
 *
 * One durable, schema-validated JSON record per delegation INVOCATION —
 * success AND failure (including schema/mapping preflight rejections and
 * background `running` starts). Records live under the project-owned
 * `.omo/deepseek-delegate/audit/` directory (gitignored) and follow the
 * naming contract `auditPathForJob` already reserves in
 * `src/delegate-execute.ts`: `<audit_dir>/<job_id>.json` for job-backed
 * attempts, `preflight-<ts>-<hex>.json` for attempts that never reached a
 * job (no job id exists).
 *
 * ## What a record is
 *
 * The audit is a METADATA ledger, never a transcript. A record carries
 * identity (preset/cwd/model/permission_mode/session/job), admission facts
 * (image PATHS, env-allowlist KEY NAMES, the helper command that references
 * the persisted `<job_id>.request.json` instead of inlining its body), a
 * one-way `context_hash` fingerprint of the effective prompt/content blocks,
 * the outcome (finish_reason / error code + REDACTED message), and the two
 * security markers (`unrestricted_confirmation`, `network_caveat_v1`).
 *
 * NEVER written into a record: the prompt text, the context packet body,
 * the API key or its value, image file CONTENTS (paths only), the request
 * JSON body, DSH session logs, or `final_response`. The final redaction
 * sweep over the serialized JSON is defense-in-depth for future fields.
 *
 * ## Redaction + caps
 *
 * Every free-text field that can reach a record is redacted through
 * `redactSecrets` (sk-/Bearer/AKIA/api-key patterns + the literal
 * `DEEPSEEK_API_KEY` value) and error messages are capped at 2000 chars —
 * the same discipline the execute core applies, re-applied here because the
 * audit must never trust upstream layers.
 *
 * ## Context hash
 *
 * `context_hash` = sha256 hex over the canonical (sorted-key) JSON of the
 * EFFECTIVE body the delegate runner received, reconstructed with the SAME
 * builders the execute core uses (so the digest is faithful, not
 * approximate):
 *  - explore / unrestricted: the caller prompt verbatim;
 *  - write: `buildWritePrompt` output (the rendered packet or the
 *    auto-context wrapper) when the packet is present/usable;
 *  - vision: the assembled content blocks (`{type:'text'}` + image blocks)
 *    when the images still pass admission; per-image byte reads are capped
 *    (4 MiB) so a huge attachment cannot balloon the audit pass.
 * Any reconstruction failure (file vanished mid-run, forged unrenderable
 * packet, over-budget image) falls back to a hash of what was DECLARED
 * (`{ prompt, context_packet?, images? }`) — the record is then honest about
 * the attempt, not the wire body. Hashing is one-way: secrets inside the
 * prompt never appear in the record.
 *
 * ## Unrestricted marker
 *
 * `unrestricted_confirmation` is true ONLY when the attempt's preset is
 * `unrestricted` AND the full input schema parsed successfully — i.e. the
 * exact `UNRESTRICTED_CONFIRMATION_TOKEN` was verified at the schema layer
 * (the mapping layer re-verifies it before `danger-full-access` is ever
 * derived). The TOKEN ITSELF is never written to any record — only this
 * boolean marker. Every record also carries `network_caveat_v1: true`: v1
 * confines FILE effects but does NOT hard-block network access.
 *
 * ## Failure semantics
 *
 * `writeAudit` throws typed `AuditError`s (invalid record / filesystem
 * failure). `writeAuditFromResult` — the surface the tool wrapper calls —
 * NEVER throws and returns the written path or null, so an audit failure can
 * never change the tool's behavior.
 *
 * No credentials, no real API calls, no new dependencies. Module import is
 * side-effect-free (the directory is created on first write, never at
 * import), keeping tool-import probes hermetic.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

import { ENV_ALLOWLIST, redactSecrets } from '../scripts/runner-lib.ts'
import { buildWritePrompt } from './context.ts'
import { DELEGATE_STATE_ROOT } from './preset-map.ts'
import {
  PERMISSION_MODES,
  PRESETS,
  UNRESTRICTED_CONFIRMATION_TOKEN,
  contextPacketSchema,
  deepseekDelegateInputSchema,
  type DelegateOutput,
  type PermissionMode,
  type Preset,
} from './schema.ts'
import { buildImageContentBlocks, resolveVisionInput } from './vision.ts'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * Project-owned audit directory: `<project>/.omo/deepseek-delegate/audit/`.
 * Mirrors `auditPathForJob` in src/delegate-execute.ts, which reserves
 * `<DELEGATE_STATE_ROOT>/audit/<job_id>.json` — this module writes exactly
 * there so job-backed outputs and on-disk files never drift.
 */
export const AUDIT_DIR = join(DELEGATE_STATE_ROOT, 'audit')

/** Cap for redacted error messages recorded in the ledger (mirrors the core). */
export const AUDIT_ERROR_MESSAGE_MAX_CHARS = 2000

/** Truncation marker appended whenever a capped field is cut. */
export const AUDIT_TRUNCATION_MARKER = '... [truncated]'

/**
 * Per-image byte cap for the vision context-hash reconstruction (see module
 * docs): beyond this, the audit degrades to hashing the DECLARED paths
 * instead of reading the file body again.
 */
export const AUDIT_VISION_HASH_MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** Background job ids look like `bg_<hex>` (mirrors src/jobs.ts). */
const JOB_ID_PATTERN = /^bg_[a-zA-Z0-9]{8,64}$/

/* ------------------------------------------------------------------ */
/* Record schema (strict: no extra fields can sneak in)                */
/* ------------------------------------------------------------------ */

/**
 * One audit record. Strict object: every field is declared here and nothing
 * else may appear. `changed_file_summary` is DELIBERATELY ABSENT in v1 — the
 * runner does not yet report a reliable per-file change set — and strict
 * parsing rejects any attempt to add it (v1 audit is a metadata ledger, and
 * an omitted field is safer than an unreliable one).
 */
export const auditRecordSchema = z.strictObject({
  /** ISO-8601 timestamp of the invocation start (the attempt time). */
  timestamp: z.iso.datetime(),
  /** Preset the call was made with (schema-derived identity on failures). */
  preset: z.enum(PRESETS),
  /** Workspace directory the delegation targeted (resolved absolute). */
  cwd: z.string().min(1),
  /** Reused DSH session id, when the run produced/echoed one. */
  session_id: z.string().optional(),
  /** `bg_<hex>` job id when the attempt reached the job layer. */
  job_id: z.string().optional(),
  /** Computed model id (schema capability matrix; never caller text). */
  model: z.string().min(1),
  /** Resolved file-effect mode for the preset. */
  permission_mode: z.enum(PERMISSION_MODES),
  /** Vision image PATHS (absolute when resolvable). Never image contents. */
  image_paths: z.array(z.string()),
  /**
   * sha256 hex of the effective prompt/content blocks — see module docs.
   * One-way fingerprint; secrets and context bodies never appear in the file.
   */
  context_hash: z.string().regex(/^[a-f0-9]{64}$/, 'context_hash must be a sha256 hex digest'),
  /**
   * KEY NAMES of the fixed runner env allowlist in effect for every v1
   * delegation (ENV_ALLOWLIST in scripts/runner-lib.ts). Names only — values
   * are never recorded.
   */
  env_allowlist_keys: z.array(z.enum(ENV_ALLOWLIST)),
  /**
   * Replay hint referencing the PERSISTED request file
   * (`<job_id>.request.json`), never inlining prompt/secrets. Omitted for
   * attempts that never spawned the runner (no job id exists).
   */
  helper_command: z.string().optional(),
  /** Runner finish-reason kind surfaced verbatim (completed/max-tokens/…). */
  finish_reason: z.string().optional(),
  /** Structured error code when the invocation failed. */
  error_code: z.string().optional(),
  /** REDACTED + capped (2000 chars) error message when the invocation failed. */
  error_message: z.string().optional(),
  /**
   * True ONLY for unrestricted attempts whose exact confirmation token was
   * verified at the schema layer (the mapping layer re-verifies before
   * danger-full-access). The token string itself is never recorded.
   */
  unrestricted_confirmation: z.boolean(),
  /** True when the call asked for the background job lifecycle. */
  run_in_background: z.boolean(),
  /**
   * v1 marker on EVERY record: explore/write/vision confine FILE effects,
   * but v1 does NOT hard-block network access from the delegated agent.
   * A literal `true` — it cannot be recorded as anything else.
   */
  network_caveat_v1: z.literal(true),
})
export type AuditRecord = z.infer<typeof auditRecordSchema>

/* ------------------------------------------------------------------ */
/* Typed errors                                                        */
/* ------------------------------------------------------------------ */

export type AuditErrorCode = 'AUDIT_INVALID' | 'AUDIT_WRITE_FAILED'

/** A record could not be validated or persisted. */
export class AuditError extends Error {
  readonly code: AuditErrorCode
  constructor(code: AuditErrorCode, message: string) {
    super(message)
    this.name = 'AuditError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Literal values the audit redacts wholesale wherever they appear:
 * the `UNRESTRICTED_CONFIRMATION_TOKEN` (schema/mapping error messages
 * embed it to instruct the caller — the audit must never repeat it; only
 * the boolean marker may say a token was verified) and the literal
 * `DEEPSEEK_API_KEY` value (when present).
 */
function redactionExtras(): string[] {
  const out: string[] = [UNRESTRICTED_CONFIRMATION_TOKEN]
  const key = process.env.DEEPSEEK_API_KEY
  if (key !== undefined && key !== '') out.push(key)
  return out
}

/** Redaction of every free-text field, re-applied at the audit boundary. */
function redact(text: string): string {
  return redactSecrets(text, redactionExtras())
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}${AUDIT_TRUNCATION_MARKER}`
}

function formatIssues(
  issues: readonly { path: readonly (string | number | symbol)[]; message: string }[],
): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/** Deterministic JSON serialization (sorted keys at every nesting level). */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(',')
    return `{${body}}`
  }
  const scalar = JSON.stringify(value)
  return scalar === undefined ? 'null' : scalar
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Resolve declared image paths against the recorded cwd (pure string math). */
function resolveDeclaredPaths(images: readonly string[], cwd: string): string[] {
  return images.map((image) => (isAbsolute(image) ? image : resolve(cwd, image)))
}

/* ------------------------------------------------------------------ */
/* Context hash                                                        */
/* ------------------------------------------------------------------ */

/**
 * Reconstruct the EFFECTIVE body the delegate runner received, using the
 * same builders the execute core uses (see module docs). Falls back to the
 * declared context on any reconstruction failure so a record is always
 * writable.
 */
function effectiveContextMaterial(input: Record<string, unknown>): unknown {
  const preset = typeof input.preset === 'string' ? input.preset : ''
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const cwd = typeof input.cwd === 'string' ? input.cwd : ''

  if (preset === 'write') {
    const declared = input.context_packet
    const allowAuto = input.allow_auto_context === true
    if (declared !== undefined || allowAuto) {
      // The packet must survive the schema before we render it (a forged
      // packet would throw in the builder — same gate the core relies on).
      const parsedPacket =
        declared === undefined ? undefined : contextPacketSchema.safeParse(declared)
      if (parsedPacket === undefined || parsedPacket.success) {
        try {
          const built = buildWritePrompt({
            packet: parsedPacket === undefined ? undefined : parsedPacket.data,
            rawPrompt: prompt,
            allow_auto_context: allowAuto,
          })
          return { prompt: built.prompt }
        } catch {
          // Unrenderable packet: hash what was declared (preflight failure).
          return { prompt, context_packet: declared ?? null }
        }
      }
      return { prompt, context_packet: declared }
    }
    return { prompt }
  }

  if (preset === 'vision') {
    const declared = Array.isArray(input.images)
      ? input.images.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (declared.length > 0) {
      try {
        const resolved = resolveVisionInput(declared, cwd)
        // Cap per-image byte reads: over-budget images fall back to the
        // declared-path hash instead of being re-read wholesale.
        if (resolved.every((image) => image.bytes <= AUDIT_VISION_HASH_MAX_IMAGE_BYTES)) {
          const blocks = [
            { type: 'text' as const, text: prompt },
            ...buildImageContentBlocks(resolved).map((block) => ({
              type: block.type,
              attachment: block.attachment,
            })),
          ]
          return { content_blocks: blocks }
        }
      } catch {
        // Image vanished/failed admission mid-run: hash the declared paths.
      }
      return { prompt, images: resolveDeclaredPaths(declared, cwd) }
    }
    return { prompt }
  }

  return { prompt }
}

/** One-way fingerprint of the effective prompt/content blocks for a call. */
export function contextHashOf(input: Record<string, unknown>): string {
  return sha256Hex(canonicalStringify(effectiveContextMaterial(input)))
}

/* ------------------------------------------------------------------ */
/* Record construction                                                 */
/* ------------------------------------------------------------------ */

/** Everything the audit needs to describe one invocation. */
export interface AuditSource {
  /** The exact object passed to `runDelegate` (raw args + resolved cwd). */
  input: Record<string, unknown>
  /** The final DelegateOutput `runDelegate` resolved with. */
  output: DelegateOutput
  /** Invocation start time (attempt time; the record's `timestamp`). */
  startedAt: Date
  /** Optional job id override (used when the output does not carry one). */
  jobId?: string
}

/**
 * Compute the full audit record from the invocation input + final output.
 *
 * `output` is authoritative for preset/model/permission_mode (it carries the
 * schema-derived identity even on preflight failures); `input` supplies cwd,
 * declared images, background flag, and the context to fingerprint.
 */
export function buildAuditRecord(source: AuditSource): AuditRecord {
  const { input, output, startedAt } = source
  const preset: Preset = output.preset
  const permissionMode: PermissionMode = output.permission_mode
  const cwd = typeof input.cwd === 'string' ? input.cwd : ''
  const declaredImages = Array.isArray(input.images)
    ? input.images.filter((entry): entry is string => typeof entry === 'string')
    : []
  const sessionId =
    typeof output.session_id === 'string'
      ? output.session_id
      : typeof input.session_id === 'string'
        ? input.session_id
        : undefined
  const jobId =
    typeof output.job_id === 'string' ? output.job_id : typeof source.jobId === 'string' ? source.jobId : undefined
  const runInBackground = input.run_in_background === true

  // The marker is true ONLY when the token survived the schema layer: the
  // full input parse succeeded AND the preset is unrestricted. (Mapping
  // re-verifies before danger-full-access is derived; this audit does not
  // need to — it records that the schema/mapping gate verified the token.)
  const parsedInput = deepseekDelegateInputSchema.safeParse(input)
  const unrestrictedConfirmation =
    parsedInput.success && parsedInput.data.preset === 'unrestricted'

  const record: AuditRecord = {
    timestamp: startedAt.toISOString(),
    preset,
    cwd,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(jobId === undefined ? {} : { job_id: jobId }),
    model: output.model,
    permission_mode: permissionMode,
    image_paths: resolveDeclaredPaths(declaredImages, cwd),
    context_hash: contextHashOf(input),
    env_allowlist_keys: [...ENV_ALLOWLIST],
    // Replay hint only for job-backed attempts (no job ⇒ nothing spawned).
    ...(jobId !== undefined && JOB_ID_PATTERN.test(jobId)
      ? { helper_command: `bun scripts/delegate-runner.ts --request ${jobId}.request.json` }
      : {}),
    ...(output.finish_reason === undefined ? {} : { finish_reason: output.finish_reason }),
    ...(output.error === undefined
      ? {}
      : {
          error_code: output.error.code,
          error_message: truncate(redact(output.error.message), AUDIT_ERROR_MESSAGE_MAX_CHARS),
        }),
    unrestricted_confirmation: unrestrictedConfirmation,
    run_in_background: runInBackground,
    network_caveat_v1: true,
  }
  return record
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

/**
 * Validate a record through `auditRecordSchema` and persist it atomically
 * (temp file + rename in the same directory). Returns the written path.
 *
 * @throws {AuditError} AUDIT_INVALID when the record violates the schema
 *   (extra fields included) or AUDIT_WRITE_FAILED on filesystem errors.
 */
export function writeAudit(record: AuditRecord, dir: string = AUDIT_DIR): string {
  const parsed = auditRecordSchema.safeParse(record)
  if (!parsed.success) {
    throw new AuditError('AUDIT_INVALID', `refusing to persist an invalid audit record: ${formatIssues(parsed.error.issues)}`)

  }
  const data = parsed.data

  // Job-backed attempts adopt the naming contract auditPathForJob reserves
  // (`<audit_dir>/<job_id>.json`) so outputs and files never drift. A
  // malformed job id (defense in depth) falls back to preflight naming.
  const fileName =
    data.job_id !== undefined && JOB_ID_PATTERN.test(data.job_id)
      ? `${data.job_id}.json`
      : `preflight-${data.timestamp.replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}.json`
  const file = join(dir, fileName)

  // Final redaction sweep over the serialized JSON: defense-in-depth so a
  // future field that carries free text cannot leak a credential-shaped
  // substring into the ledger. Replaced literals keep the JSON well-formed
  // (redaction only rewrites inside string values).
  const json = `${redact(JSON.stringify(data, null, 2))}\n`

  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, json, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw new AuditError('AUDIT_WRITE_FAILED', `cannot persist audit record at ${file}: ${messageOf(error)}`)
  }
  return file
}

export interface AuditWriterOptions {
  /** Audit directory override (tests/hermetic runs); defaults to AUDIT_DIR. */
  dir?: string
}

/**
 * Write one audit record for an invocation — success AND failure. This is
 * the surface the tool wrapper calls once per `deepseek_delegate`
 * invocation, after `runDelegate` resolves.
 *
 * NEVER throws: an audit failure must never change the tool's behavior.
 * Returns the written file path, or null when the record could not be
 * built/persisted.
 */
export function writeAuditFromResult(source: AuditSource, options: AuditWriterOptions = {}): string | null {
  try {
    return writeAudit(buildAuditRecord(source), options.dir ?? AUDIT_DIR)
  } catch {
    // Best-effort by contract (see module docs): no audit, no tool impact.
    return null
  }
}
