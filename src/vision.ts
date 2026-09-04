/**
 * Vision input admission and optional workspace-write permission handling for
 * the DeepSeek delegation tool (plan todo 9).
 *
 * This module is the vision-side admission gate: it validates image paths,
 * sniffs magic bytes (no image-processing dependency), resolves duplicates,
 * builds the DSH content-block shape the installed rc.5 runtime accepts, and
 * gates the optional `workspace-write` permission for vision.
 *
 * ## Resolved content-block shape (investigated end-to-end)
 *
 * The SDK JSON-RPC `session/prompt` wire carries `contentBlocks: ContentBlock[]`
 * (`@deepseek-ai/dsh-llm`). The image block is:
 *
 * ```ts
 * { type: 'image', attachment: ImageAttachmentRef }
 * ```
 *
 * where `ImageAttachmentRef` (`@deepseek-ai/dsh-attachment`) is:
 *
 * ```ts
 * {
 *   attachmentId: string        // branded AttachmentId; content-addressed 'sha256:<64 hex>'
 *   mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
 *   bytes: number               // exact encoded byte length
 *   width: number               // intrinsic encoded width (px)
 *   height: number              // intrinsic encoded height (px)
 *   name?: string               // display name, path-stripped
 * }
 * ```
 *
 * The `sdk-jsonrpc-server` forwards caller content blocks **verbatim**
 * (`createUserMessage` → `deepFreeze(structuredClone)`), with **no validation,
 * no whitelist, no base64 decoding, and no image-upload RPC**. The DeepSeek
 * adapter (`llm-deepseek`) resolves `block.attachment.attachmentId` through
 * `ctx.attachments` at request time and rejects image input with
 * `UNSUPPORTED_CONTENT` when the durable store is absent or the id is
 * unregistered.
 *
 * ### Residual risk (documented)
 *
 * An out-of-process bridge cannot call `ctx.attachments.saveImages` directly
 * (that API lives inside the runtime process), and the SDK protocol exposes no
 * image-upload method. The `attachmentId` is content-addressed, so this module
 * computes `sha256:<hex>` of the **raw** file bytes as the best honest
 * content-addressed id; the runtime's attachment-local store may recompute the
 * id over **normalized** bytes (decode → scale → re-encode) during real
 * registration, in which case the locally-computed id will not match and the
 * adapter will fail to resolve the image. `width` and `height` are set to `0`
 * because this module performs no image decoding; the store recomputes
 * intrinsic dimensions during normalization. End-to-end vision delivery
 * therefore requires the deployment composition to mount
 * `@deepseek-ai/dsh-attachment-local` (our `dsh/cordis/vision.cordis.yml` does)
 * and a registration channel (in-process `saveImages`, a `read_image` tool, or
 * direct disk writes to the store's content-addressed layout) — none of which
 * the SDK wire provides. The block SHAPE produced here is the documented,
 * type-correct shape; the registration gap is a runtime-deployment concern.
 */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'

/* ------------------------------------------------------------------ */
/* Supported image types                                               */
/* ------------------------------------------------------------------ */

/**
 * File extensions accepted for vision input. Matches the DSH attachment-local
 * + llm-deepseek admission set: PNG, JPEG (jpg/jpeg), WebP, GIF.
 */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number]

/**
 * MIME types guessed from magic bytes. Mirrors `ImageMediaType` from
 * `@deepseek-ai/dsh-attachment` and the ACP inline-image admission list.
 */
export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number]

/** Number of leading bytes read for magic-byte sniffing. */
const MAGIC_READ_LEN = 12

/* ------------------------------------------------------------------ */
/* Magic-byte signatures                                               */
/* ------------------------------------------------------------------ */

interface MagicSignature {
  readonly mediaType: SupportedImageType
  readonly ext: ImageExtension
  /** Leading magic bytes at offset 0. */
  readonly prefix: readonly number[]
  /** Optional secondary check at a nonzero offset (e.g. WebP "WEBP" at 8). */
  readonly secondary?: { readonly offset: number; readonly bytes: readonly number[] }
}

const SIGNATURES: readonly MagicSignature[] = [
  {
    mediaType: 'image/png',
    ext: 'png',
    prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  {
    mediaType: 'image/jpeg',
    ext: 'jpg',
    prefix: [0xff, 0xd8, 0xff],
  },
  {
    mediaType: 'image/gif',
    ext: 'gif',
    prefix: [0x47, 0x49, 0x46, 0x38], // "GIF8" — covers GIF87a and GIF89a
  },
  {
    mediaType: 'image/webp',
    ext: 'webp',
    prefix: [0x52, 0x49, 0x46, 0x46], // "RIFF"
    secondary: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // "WEBP"
  },
]

/* ------------------------------------------------------------------ */
/* Typed errors                                                        */
/* ------------------------------------------------------------------ */

export type VisionErrorCode =
  | 'FILE_NOT_FOUND'
  | 'PATH_NOT_FILE'
  | 'EMPTY_FILE'
  | 'UNSUPPORTED_EXTENSION'
  | 'UNSUPPORTED_CONTENT'
  | 'IMAGE_MAGIC_MISMATCH'
  | 'DUPLICATE_IMAGE'
  | 'IMAGE_UNREADABLE'
  | 'IMAGE_READ_FAILED'

/**
 * Typed, per-file vision admission error. Every failure path names a precise
 * `code` and the offending `path` so the audit writer (todo 10) and the caller
 * can distinguish rejection reasons without parsing free-text messages.
 */
export class VisionInputError extends Error {
  readonly code: VisionErrorCode
  readonly path: string
  constructor(code: VisionErrorCode, path: string, message: string) {
    super(message)
    this.name = 'VisionInputError'
    this.code = code
    this.path = path
  }
}

/* ------------------------------------------------------------------ */
/* probeImage                                                          */
/* ------------------------------------------------------------------ */

export interface ProbedImage {
  /** Absolute path of the validated image. */
  path: string
  /** Lowercased extension without leading dot (e.g. `png`, `jpg`). */
  ext: ImageExtension
  /** MIME type guessed from magic bytes. */
  mimeGuess: SupportedImageType
  /** Exact file size in bytes (must be > 0). */
  bytes: number
}

/**
 * Probe a single image path: stat (must exist, be a regular file, nonzero
 * size), sniff the extension against the allowlist, and verify the leading
 * magic bytes match a supported image signature.
 *
 * Admission policy:
 *  - The **extension** drives eligibility (must be in {@link IMAGE_EXTENSIONS}).
 *  - The **magic bytes** verify the content is genuinely one of the four
 *    supported image formats.
 *  - If the sniffed content type differs from the extension's claimed type
 *    (e.g. a `.png` file that is actually GIF bytes), the probe rejects with
 *    `IMAGE_MAGIC_MISMATCH` rather than silently reclassifying — the audit
 *    trail must reflect the true input.
 *
 * @param path - absolute or relative path to the image file.
 * @throws {VisionInputError} with a precise `code` on every failure path.
 */
export function probeImage(path: string): ProbedImage {
  // stat — must exist and be a regular file (not a directory, not a device).
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new VisionInputError('FILE_NOT_FOUND', path, `image file not found: ${path}`)
    }
    if (code === 'EACCES') {
      throw new VisionInputError('IMAGE_UNREADABLE', path, `image file is not readable: ${path}`)
    }
    throw new VisionInputError('IMAGE_READ_FAILED', path, `cannot stat image: ${String(error)}`)
  }
  if (!st.isFile()) {
    throw new VisionInputError('PATH_NOT_FILE', path, `image path is not a regular file: ${path}`)
  }
  if (st.size === 0) {
    throw new VisionInputError('EMPTY_FILE', path, `image file is empty (zero bytes): ${path}`)
  }

  // extension — must be in the allowlist.
  const ext = extname(path).slice(1).toLowerCase()
  if (!isImageExtension(ext)) {
    throw new VisionInputError(
      'UNSUPPORTED_EXTENSION',
      path,
      `unsupported image extension ".${ext || '(none)'}": only ${IMAGE_EXTENSIONS.join(', ')} are accepted`,
    )
  }

  // magic bytes — read the leading bytes and sniff the true content type.
  const head = readHead(path, MAGIC_READ_LEN)
  const sniffed = sniffMagic(head)
  if (sniffed === undefined) {
    throw new VisionInputError(
      'UNSUPPORTED_CONTENT',
      path,
      `file content does not match any supported image signature (png/jpeg/webp/gif): ${path}`,
    )
  }
  if (sniffed.ext !== ext && !(ext === 'jpeg' && sniffed.ext === 'jpg')) {
    // .jpg and .jpeg both map to the jpeg signature; treat them as equivalent.
    throw new VisionInputError(
      'IMAGE_MAGIC_MISMATCH',
      path,
      `image extension ".${ext}" does not match content magic bytes (actual: ${sniffed.mediaType}/${sniffed.ext}): ${path}`,
    )
  }

  return { path, ext, mimeGuess: sniffed.mediaType, bytes: st.size }
}

/* ------------------------------------------------------------------ */
/* resolveVisionInput                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resolve and validate an array of image paths for a vision delegation.
 *
 * - Each relative path is resolved against `cwd`.
 * - Each image is probed via {@link probeImage}.
 * - **Duplicates are rejected**: the same resolved absolute path appearing
 *   more than once is a `DUPLICATE_IMAGE` error. Sending the same attachment
 *   twice is wasteful and the audit trail should reflect unique inputs; the
 *   caller (tool layer) is responsible for deduplication before calling.
 * - Input order is preserved in the returned array.
 *
 * @param images - array of absolute or relative image paths.
 * @param cwd - workspace directory for resolving relative paths.
 * @returns validated, de-duplicated image descriptors in input order.
 * @throws {VisionInputError} on the first failing image (precise `code`).
 */
export function resolveVisionInput(images: string[], cwd: string): ProbedImage[] {
  const seen = new Set<string>()
  const out: ProbedImage[] = []
  for (const raw of images) {
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw)
    if (seen.has(abs)) {
      throw new VisionInputError(
        'DUPLICATE_IMAGE',
        abs,
        `duplicate image path (each image must appear at most once): ${abs}`,
      )
    }
    seen.add(abs)
    out.push(probeImage(abs))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* buildImageContentBlocks                                              */
/* ------------------------------------------------------------------ */

/**
 * The DSH content-block image shape accepted by the installed rc.5 runtime.
 *
 * See the module docstring for the investigated wire contract and residual
 * risk. This is the `ImageBlock` variant of `ContentBlock` from
 * `@deepseek-ai/dsh-llm`, carrying an `ImageAttachmentRef` from
 * `@deepseek-ai/dsh-attachment`.
 */
export interface ImageContentBlock {
  readonly type: 'image'
  readonly attachment: {
    /** Content-addressed storage id (`sha256:<64 lowercase hex>`). */
    readonly attachmentId: string
    readonly mediaType: SupportedImageType
    readonly bytes: number
    /**
     * Intrinsic encoded width in pixels. Set to `0` here because this module
     * performs no image decoding; the runtime attachment store recomputes
     * intrinsic dimensions during normalization/registration.
     */
    readonly width: number
    /** Intrinsic encoded height in pixels. Set to `0` (see {@link width}). */
    readonly height: number
    /** Optional display name (basename, path-stripped). */
    readonly name?: string
  }
}

/**
 * Build DSH image content blocks from validated images.
 *
 * The caller (tool layer / bridge) should interleave these with a leading
 * `{ type: 'text', text: prompt }` block to preserve text/image order, since
 * the DeepSeek adapter preserves user-message content order and the vision
 * model expects a textual instruction alongside the image.
 *
 * The `attachmentId` is computed as `sha256:<hex>` of the **raw** file bytes
 * (content-addressed). See the module docstring for the residual risk: the
 * runtime store may recompute the id over normalized bytes, so end-to-end
 * delivery requires a registration channel the SDK wire does not provide.
 *
 * @param images - validated image descriptors from {@link resolveVisionInput}.
 * @returns image content blocks in input order.
 */
export function buildImageContentBlocks(images: readonly ProbedImage[]): ImageContentBlock[] {
  return images.map((img) => {
    const rawBytes = readAllBytes(img.path)
    const hash = createHash('sha256').update(rawBytes).digest('hex')
    return {
      type: 'image' as const,
      attachment: {
        attachmentId: `sha256:${hash}`,
        mediaType: img.mimeGuess,
        bytes: img.bytes,
        width: 0,
        height: 0,
        name: basename(img.path),
      },
    }
  })
}

/* ------------------------------------------------------------------ */
/* Permission gating                                                    */
/* ------------------------------------------------------------------ */

/**
 * Permission modes relevant to vision delegation. The schema (todo 2) already
 * rejects `danger-full-access` for the `vision` preset via `superRefine`; this
 * function is a defense-in-depth runtime guard.
 */
export const VISION_ALLOWED_PERMISSION_MODES = ['read-only', 'workspace-write'] as const
export type VisionPermissionMode = (typeof VISION_ALLOWED_PERMISSION_MODES)[number]

/**
 * Returns `true` when the vision call explicitly requested workspace-write
 * permission. Vision defaults to `read-only`; `workspace-write` is allowed
 * only when the caller opts in.
 */
export function requiresWritePermission(permissionMode: string): boolean {
  return permissionMode === 'workspace-write'
}

/**
 * Assert that the given permission mode is admissible for vision delegation.
 *
 * The `vision` preset never permits `danger-full-access` (the schema rejects
 * it upstream; this guard is defense-in-depth for callers that bypass schema
 * validation, e.g. a bridge that maps modes independently).
 *
 * @throws {VisionInputError} with code `UNSUPPORTED_EXTENSION`-style? No —
 *   throws a typed error with code `UNSUPPORTED_CONTENT` is wrong semantics.
 *   Uses a plain `Error` with a clear message, since permission is not a
 *   per-file vision-input error. Actually, for consistency with the audit
 *   trail, we throw a `VisionInputError`-adjacent error. Let's keep it simple:
 *   throws `Error` — the schema is the authoritative gate.
 */
export function assertVisionPermissionAllowed(permissionMode: string): void {
  if (permissionMode === 'danger-full-access') {
    throw new Error(
      `vision preset never permits permission_mode "danger-full-access" (schema rejects it; this is a defense-in-depth guard)`,
    )
  }
  if (!VISION_ALLOWED_PERMISSION_MODES.includes(permissionMode as VisionPermissionMode)) {
    throw new Error(
      `vision preset only permits permission_mode "read-only" or "workspace-write" (got "${permissionMode}")`,
    )
  }
}

/* ------------------------------------------------------------------ */
/* Audit metadata                                                       */
/* ------------------------------------------------------------------ */

/**
 * Metadata consumed by the audit writer (todo 10) for vision delegations.
 * Captures each validated image's identity + whether write was requested.
 */
export interface VisionAuditMetadata {
  readonly images: readonly {
    readonly path: string
    readonly bytes: number
    readonly ext: ImageExtension
    readonly mimeGuess: SupportedImageType
  }[]
  readonly writeRequested: boolean
}

/**
 * Build audit metadata for a vision delegation from validated images and the
 * resolved permission mode.
 */
export function buildVisionAuditMetadata(
  images: readonly ProbedImage[],
  permissionMode: string,
): VisionAuditMetadata {
  return {
    images: images.map((img) => ({
      path: img.path,
      bytes: img.bytes,
      ext: img.ext,
      mimeGuess: img.mimeGuess,
    })),
    writeRequested: requiresWritePermission(permissionMode),
  }
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                     */
/* ------------------------------------------------------------------ */

function isImageExtension(ext: string): ext is ImageExtension {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
}

/** Read the leading `n` bytes of a file for magic-byte sniffing. */
function readHead(path: string, n: number): Buffer {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new VisionInputError('FILE_NOT_FOUND', path, `image file not found: ${path}`)
    }
    if (code === 'EACCES') {
      throw new VisionInputError('IMAGE_UNREADABLE', path, `image file is not readable: ${path}`)
    }
    throw new VisionInputError('IMAGE_READ_FAILED', path, `cannot open image: ${String(error)}`)
  }
  try {
    const buf = Buffer.alloc(n)
    const bytesRead = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } catch (error) {
    throw new VisionInputError(
      'IMAGE_READ_FAILED',
      path,
      `cannot read image header: ${String(error)}`,
    )
  } finally {
    closeSync(fd)
  }
}

/** Sniff the true image media type from leading magic bytes. */
function sniffMagic(head: Buffer): MagicSignature | undefined {
  for (const sig of SIGNATURES) {
    if (!bytesEqual(head, 0, sig.prefix)) continue
    if (sig.secondary !== undefined) {
      if (!bytesEqual(head, sig.secondary.offset, sig.secondary.bytes)) continue
    }
    return sig
  }
  return undefined
}

function bytesEqual(buf: Buffer, offset: number, expected: readonly number[]): boolean {
  if (buf.length < offset + expected.length) return false
  for (let i = 0; i < expected.length; i++) {
    if (buf[offset + i] !== expected[i]) return false
  }
  return true
}

/** Read the entire file bytes (for sha256 content-addressing). */
function readAllBytes(path: string): Buffer {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new VisionInputError('FILE_NOT_FOUND', path, `image file not found: ${path}`)
    }
    if (code === 'EACCES') {
      throw new VisionInputError('IMAGE_UNREADABLE', path, `image file is not readable: ${path}`)
    }
    throw new VisionInputError('IMAGE_READ_FAILED', path, `cannot open image: ${String(error)}`)
  }
  try {
    const st = fstatSync(fd)
    const buf = Buffer.alloc(st.size)
    let read = 0
    while (read < st.size) {
      const chunk = readSync(fd, buf, read, st.size - read, read)
      if (chunk === 0) break
      read += chunk
    }
    return buf.subarray(0, read)
  } catch (error) {
    throw new VisionInputError(
      'IMAGE_READ_FAILED',
      path,
      `cannot read image bytes: ${String(error)}`,
    )
  } finally {
    closeSync(fd)
  }
}
