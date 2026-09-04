/**
 * Vision input admission + content-block + permission tests (plan todo 9).
 *
 * Credential-free: no DSH runtime, no model API, no image-processing deps.
 * Fixtures are tiny REAL image bytes generated at test time from base64
 * constants (1x1 PNG, 1x1 GIF89a, a minimal JPEG-magic file) plus synthetic
 * failure cases (.txt, zero-byte, directory, nonexistent, mismatched ext).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  IMAGE_EXTENSIONS,
  SUPPORTED_IMAGE_TYPES,
  VisionInputError,
  assertVisionPermissionAllowed,
  buildImageContentBlocks,
  buildVisionAuditMetadata,
  probeImage,
  requiresWritePermission,
  resolveVisionInput,
} from '../src/vision'
import { deepseekDelegateInputSchema } from '../src/schema'

/* ------------------------------------------------------------------ */
/* Real tiny image fixtures (base64 constants)                          */
/* ------------------------------------------------------------------ */

/** Valid 1x1 transparent PNG (70 bytes). Decodes to PNG magic 89504e47... */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')

/** Valid 1x1 GIF89a (43 bytes). Decodes to GIF89a magic. */
const GIF_BASE64 = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
const GIF_BYTES = Buffer.from(GIF_BASE64, 'base64')

/** Minimal JPEG with JFIF magic (FF D8 FF E0 + JFIF marker). Not a real image
 *  but carries the JPEG magic bytes the probe sniffs. */
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, // SOI + APP0 marker
  0x00, 0x10, // length
  0x4a, 0x46, 0x49, 0x46, // "JFIF"
  0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // version + density
  0xff, 0xd9, // EOI
])

/* ------------------------------------------------------------------ */
/* Temp fixture directory                                              */
/* ------------------------------------------------------------------ */

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vision-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function fixture(name: string, bytes: Buffer): string {
  const p = join(tmpDir, name)
  writeFileSync(p, bytes)
  return p
}

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

describe('constants', () => {
  test('IMAGE_EXTENSIONS lists exactly png/jpg/jpeg/webp/gif', () => {
    expect([...IMAGE_EXTENSIONS]).toEqual(['png', 'jpg', 'jpeg', 'webp', 'gif'])
  })

  test('SUPPORTED_IMAGE_TYPES lists exactly the four DSH media types', () => {
    expect([...SUPPORTED_IMAGE_TYPES]).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ])
  })
})

/* ------------------------------------------------------------------ */
/* probeImage — happy paths                                            */
/* ------------------------------------------------------------------ */

describe('probeImage — happy paths', () => {
  test('PNG fixture accepted with correct ext, mimeGuess, and byte length', () => {
    const p = fixture('tiny.png', PNG_BYTES)
    const img = probeImage(p)
    expect(img.ext).toBe('png')
    expect(img.mimeGuess).toBe('image/png')
    expect(img.bytes).toBe(PNG_BYTES.length)
    expect(img.path).toBe(p)
  })

  test('GIF fixture accepted with correct ext, mimeGuess, and byte length', () => {
    const p = fixture('tiny.gif', GIF_BYTES)
    const img = probeImage(p)
    expect(img.ext).toBe('gif')
    expect(img.mimeGuess).toBe('image/gif')
    expect(img.bytes).toBe(GIF_BYTES.length)
  })

  test('JPEG fixture (.jpg) accepted with correct ext, mimeGuess, and byte length', () => {
    const p = fixture('tiny.jpg', JPEG_BYTES)
    const img = probeImage(p)
    expect(img.ext).toBe('jpg')
    expect(img.mimeGuess).toBe('image/jpeg')
    expect(img.bytes).toBe(JPEG_BYTES.length)
  })

  test('.jpeg extension is accepted and maps to image/jpeg', () => {
    const p = fixture('tiny.jpeg', JPEG_BYTES)
    const img = probeImage(p)
    expect(img.ext).toBe('jpeg')
    expect(img.mimeGuess).toBe('image/jpeg')
  })

  test('WebP fixture (RIFF+WEBP) accepted', () => {
    // Minimal WebP: RIFF....WEBP
    const webpBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x00, 0x00, 0x00, 0x00, // file size (dummy)
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      0x00, 0x00, 0x00, 0x00, // dummy payload
    ])
    const p = fixture('tiny.webp', webpBytes)
    const img = probeImage(p)
    expect(img.ext).toBe('webp')
    expect(img.mimeGuess).toBe('image/webp')
    expect(img.bytes).toBe(webpBytes.length)
  })
})

/* ------------------------------------------------------------------ */
/* probeImage — failure paths (each names the reason)                  */
/* ------------------------------------------------------------------ */

describe('probeImage — failure paths', () => {
  test('.txt file rejected with UNSUPPORTED_EXTENSION', () => {
    const p = fixture('notes.txt', Buffer.from('not an image'))
    expect(() => probeImage(p)).toThrow(VisionInputError)
    try {
      probeImage(p)
    } catch (e) {
      const err = e as VisionInputError
      expect(err.code).toBe('UNSUPPORTED_EXTENSION')
      expect(err.path).toBe(p)
      expect(err.message).toContain('.txt')
    }
  })

  test('nonexistent path rejected with FILE_NOT_FOUND', () => {
    const p = join(tmpDir, 'does-not-exist.png')
    expect(() => probeImage(p)).toThrow(VisionInputError)
    try {
      probeImage(p)
    } catch (e) {
      const err = e as VisionInputError
      expect(err.code).toBe('FILE_NOT_FOUND')
      expect(err.path).toBe(p)
    }
  })

  test('directory path rejected with PATH_NOT_FILE', () => {
    const p = join(tmpDir, 'subdir')
    mkdirSync(p)
    expect(() => probeImage(p)).toThrow(VisionInputError)
    try {
      probeImage(p)
    } catch (e) {
      const err = e as VisionInputError
      expect(err.code).toBe('PATH_NOT_FILE')
      expect(err.path).toBe(p)
    }
  })

  test('zero-byte file rejected with EMPTY_FILE', () => {
    const p = fixture('empty.png', Buffer.alloc(0))
    expect(() => probeImage(p)).toThrow(VisionInputError)
    try {
      probeImage(p)
    } catch (e) {
      const err = e as VisionInputError
      expect(err.code).toBe('EMPTY_FILE')
      expect(err.path).toBe(p)
    }
  })

  test('extension/content mismatch (.png with GIF bytes) rejected with IMAGE_MAGIC_MISMATCH', () => {
    const p = fixture('mislabeled.png', GIF_BYTES)
    expect(() => probeImage(p)).toThrow(VisionInputError)
    try {
      probeImage(p)
    } catch (e) {
      const err = e as VisionInputError
      expect(err.code).toBe('IMAGE_MAGIC_MISMATCH')
      expect(err.path).toBe(p)
      expect(err.message).toContain('image/gif')
    }
  })

  test('file with non-image content but image extension rejected with UNSUPPORTED_CONTENT', () => {
    // Random bytes that don't match any magic signature.
    const p = fixture('garbage.png', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]))
    expect(() => probeImage(p)).toThrow(VisionInputError)
    try {
      probeImage(p)
    } catch (e) {
      const err = e as VisionInputError
      expect(err.code).toBe('UNSUPPORTED_CONTENT')
      expect(err.path).toBe(p)
    }
  })
})

/* ------------------------------------------------------------------ */
/* resolveVisionInput                                                   */
/* ------------------------------------------------------------------ */

describe('resolveVisionInput', () => {
  test('resolves relative paths against cwd and validates each', () => {
    const pngPath = fixture('a.png', PNG_BYTES)
    const gifPath = fixture('b.gif', GIF_BYTES)
    const resolved = resolveVisionInput(['a.png', 'b.gif'], tmpDir)
    expect(resolved).toHaveLength(2)
    expect(resolved[0].path).toBe(pngPath)
    expect(resolved[0].mimeGuess).toBe('image/png')
    expect(resolved[1].path).toBe(gifPath)
    expect(resolved[1].mimeGuess).toBe('image/gif')
  })

  test('accepts absolute paths without resolving against cwd', () => {
    const pngPath = fixture('abs.png', PNG_BYTES)
    const resolved = resolveVisionInput([pngPath], '/some/other/cwd')
    expect(resolved[0].path).toBe(pngPath)
  })

  test('rejects duplicate resolved paths with DUPLICATE_IMAGE', () => {
    const pngPath = fixture('dup.png', PNG_BYTES)
    expect(() => resolveVisionInput([pngPath, pngPath], tmpDir)).toThrow(VisionInputError)
    try {
      resolveVisionInput([pngPath, pngPath], tmpDir)
    } catch (e) {
      const err = e as VisionInputError
      expect(err.code).toBe('DUPLICATE_IMAGE')
      expect(err.path).toBe(pngPath)
    }
  })

  test('rejects duplicate via relative+absolute that resolve to the same path', () => {
    fixture('same.png', PNG_BYTES)
    expect(() => resolveVisionInput(['same.png', join(tmpDir, 'same.png')], tmpDir)).toThrow(
      VisionInputError,
    )
  })

  test('preserves input order', () => {
    const gif = fixture('z.gif', GIF_BYTES)
    const png = fixture('a.png', PNG_BYTES)
    const jpg = fixture('m.jpg', JPEG_BYTES)
    const resolved = resolveVisionInput(
      [join(tmpDir, 'z.gif'), join(tmpDir, 'a.png'), join(tmpDir, 'm.jpg')],
      tmpDir,
    )
    expect(resolved.map((i) => i.path)).toEqual([gif, png, jpg])
  })

  test('propagates per-file failure on the first bad image', () => {
    fixture('good.png', PNG_BYTES)
    const badPath = join(tmpDir, 'bad.txt')
    writeFileSync(badPath, 'nope')
    expect(() => resolveVisionInput(['good.png', 'bad.txt'], tmpDir)).toThrow(VisionInputError)
  })
})

/* ------------------------------------------------------------------ */
/* buildImageContentBlocks                                              */
/* ------------------------------------------------------------------ */

describe('buildImageContentBlocks', () => {
  test('produces the documented DSH image block shape for each image', () => {
    const pngPath = fixture('tiny.png', PNG_BYTES)
    const gifPath = fixture('tiny.gif', GIF_BYTES)
    const images = resolveVisionInput([pngPath, gifPath], tmpDir)
    const blocks = buildImageContentBlocks(images)

    expect(blocks).toHaveLength(2)

    // Block 1: PNG
    expect(blocks[0].type).toBe('image')
    expect(blocks[0].attachment.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(blocks[0].attachment.mediaType).toBe('image/png')
    expect(blocks[0].attachment.bytes).toBe(PNG_BYTES.length)
    expect(blocks[0].attachment.width).toBe(0)
    expect(blocks[0].attachment.height).toBe(0)
    expect(blocks[0].attachment.name).toBe('tiny.png')

    // Block 2: GIF
    expect(blocks[1].type).toBe('image')
    expect(blocks[1].attachment.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(blocks[1].attachment.mediaType).toBe('image/gif')
    expect(blocks[1].attachment.bytes).toBe(GIF_BYTES.length)
    expect(blocks[1].attachment.name).toBe('tiny.gif')
  })

  test('attachmentId is deterministic (sha256 of raw bytes)', () => {
    const pngPath = fixture('tiny.png', PNG_BYTES)
    const images = resolveVisionInput([pngPath], tmpDir)
    const blocks = buildImageContentBlocks(images)
    // Recompute expected hash independently.
    // createHash imported at top of file
    const expected = 'sha256:' + createHash('sha256').update(PNG_BYTES).digest('hex')
    expect(blocks[0].attachment.attachmentId).toBe(expected)
  })

  test('same content produces same attachmentId regardless of filename', () => {
    const a = fixture('a.png', PNG_BYTES)
    const b = fixture('b.png', PNG_BYTES) // same bytes, different name
    const images = resolveVisionInput([a, b], tmpDir)
    const blocks = buildImageContentBlocks(images)
    expect(blocks[0].attachment.attachmentId).toBe(blocks[1].attachment.attachmentId)
    expect(blocks[0].attachment.name).toBe('a.png')
    expect(blocks[1].attachment.name).toBe('b.png')
  })

  test('returns empty array for empty input', () => {
    expect(buildImageContentBlocks([])).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/* Permission gating                                                    */
/* ------------------------------------------------------------------ */

describe('permission gating', () => {
  test('requiresWritePermission returns true only for workspace-write', () => {
    expect(requiresWritePermission('workspace-write')).toBe(true)
    expect(requiresWritePermission('read-only')).toBe(false)
    expect(requiresWritePermission('danger-full-access')).toBe(false)
  })

  test('assertVisionPermissionAllowed accepts read-only', () => {
    expect(() => assertVisionPermissionAllowed('read-only')).not.toThrow()
  })

  test('assertVisionPermissionAllowed accepts workspace-write', () => {
    expect(() => assertVisionPermissionAllowed('workspace-write')).not.toThrow()
  })

  test('assertVisionPermissionAllowed rejects danger-full-access', () => {
    expect(() => assertVisionPermissionAllowed('danger-full-access')).toThrow(
      /danger-full-access/,
    )
  })

  test('assertVisionPermissionAllowed rejects unknown modes', () => {
    expect(() => assertVisionPermissionAllowed('bogus')).toThrow()
  })

  test('schema already rejects danger-full-access for vision preset (defense-in-depth)', () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: 'vision',
      prompt: 'describe',
      cwd: '/tmp',
      images: ['/tmp/x.png'],
      permission_mode: 'danger-full-access',
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const msgs = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      expect(msgs.some((m) => m.includes('danger-full-access'))).toBe(true)
    }
  })

  test('schema accepts vision with workspace-write', () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: 'vision',
      prompt: 'describe',
      cwd: '/tmp',
      images: ['/tmp/x.png'],
      permission_mode: 'workspace-write',
    })
    expect(r.success).toBe(true)
  })

  test('schema accepts vision with default read-only (no permission_mode)', () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: 'vision',
      prompt: 'describe',
      cwd: '/tmp',
      images: ['/tmp/x.png'],
    })
    expect(r.success).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* Audit metadata                                                       */
/* ------------------------------------------------------------------ */

describe('buildVisionAuditMetadata', () => {
  test('captures per-image identity + writeRequested=false for read-only', () => {
    const pngPath = fixture('tiny.png', PNG_BYTES)
    const images = resolveVisionInput([pngPath], tmpDir)
    const meta = buildVisionAuditMetadata(images, 'read-only')
    expect(meta.writeRequested).toBe(false)
    expect(meta.images).toHaveLength(1)
    expect(meta.images[0].path).toBe(pngPath)
    expect(meta.images[0].bytes).toBe(PNG_BYTES.length)
    expect(meta.images[0].ext).toBe('png')
    expect(meta.images[0].mimeGuess).toBe('image/png')
  })

  test('captures writeRequested=true for workspace-write', () => {
    const pngPath = fixture('tiny.png', PNG_BYTES)
    const images = resolveVisionInput([pngPath], tmpDir)
    const meta = buildVisionAuditMetadata(images, 'workspace-write')
    expect(meta.writeRequested).toBe(true)
  })

  test('preserves image order', () => {
    fixture('a.png', PNG_BYTES)
    fixture('b.gif', GIF_BYTES)
    const images = resolveVisionInput(
      [join(tmpDir, 'a.png'), join(tmpDir, 'b.gif')],
      tmpDir,
    )
    const meta = buildVisionAuditMetadata(images, 'read-only')
    expect(meta.images.map((i) => i.ext)).toEqual(['png', 'gif'])
  })
})
