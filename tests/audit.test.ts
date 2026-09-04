/**
 * Audit-ledger tests for deepseek_delegate (plan todo 10).
 *
 * Credential-free and DSH-free: every test writes audit records into a
 * throwaway OS-temp directory (never the real `.omo/deepseek-delegate/audit/`
 * tree) and never spawns a child process or calls any API.
 *
 * Coverage:
 *   happy     – writeAuditFromResult writes a valid record at the expected
 *               path (job-backed naming == auditPathForJob), validates through
 *               auditRecordSchema, leaves no .tmp residue;
 *   failure   – an error output still produces an audit record with
 *               error_code + REDACTED message (job-backed AND preflight
 *               rejections such as unrestricted-without-token);
 *   secrets   – prompt/API-key material never reaches the file, while the
 *               sha256 context_hash and the allowlist KEY NAMES do;
 *   unrestricted – marker true for a verified unrestricted run, and the
 *               confirmation token string is never written;
 *   strict    – auditRecordSchema rejects unknown fields (changed_file_summary
 *               included), and writeAudit refuses to persist them.
 */
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  AUDIT_TRUNCATION_MARKER,
  AuditError,
  auditRecordSchema,
  buildAuditRecord,
  writeAudit,
  writeAuditFromResult,
} from '../src/audit.ts'
import { auditPathForJob } from '../src/delegate-execute.ts'
import { ENV_ALLOWLIST } from '../scripts/runner-lib.ts'
import {
  UNRESTRICTED_CONFIRMATION_TOKEN,
  type DelegateInput,
  type DelegateOutput,
} from '../src/schema.ts'

/* ------------------------------------------------------------------ */
/* Fixtures + helpers                                                  */
/* ------------------------------------------------------------------ */

const CWD = '/workspace/example-repo' // never touched: audits only write metadata

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'audit-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function exploreInput(overrides: Partial<DelegateInput> = {}): DelegateInput {
  return {
    preset: 'explore',
    prompt: 'Map this repository: structure, entry points, conventions.',
    cwd: CWD,
    ...overrides,
  }
}

function completedOutput(jobId = 'bg_1234567890ab', overrides: Partial<DelegateOutput> = {}): DelegateOutput {
  return {
    status: 'completed',
    preset: 'explore',
    job_id: jobId,
    session_id: 'ses_audit_happy_1',
    model: 'deepseek-v4-flash',
    permission_mode: 'read-only',
    final_response: 'The repo is a delegation harness.',
    finish_reason: 'completed',
    ...overrides,
  }
}

function errorOutput(code: string, message: string, jobId?: string): DelegateOutput {
  return {
    status: 'error',
    preset: 'explore',
    ...(jobId === undefined ? {} : { job_id: jobId }),
    model: 'deepseek-v4-flash',
    permission_mode: 'read-only',
    error: { code, message },
  }
}

function readRecord(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** Tiny real 1x1 PNG bytes (same fixture family as the vision tests). */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

function writePngFixture(dir: string, name = 'tiny.png'): string {
  const path = join(dir, name)
  writeFileSync(path, PNG_BYTES)
  return path
}

/* ------------------------------------------------------------------ */
/* happy: valid record written at the expected path, atomically         */
/* ------------------------------------------------------------------ */

test('audit happy: writeAuditFromResult writes a valid, schema-clean record at the job-backed path with no .tmp residue', () => {
  const dir = tmpDir()
  const startedAt = new Date('2026-09-04T12:00:00.000Z')
  const input = exploreInput()
  const output = completedOutput()
  const path = writeAuditFromResult({ input, output, startedAt }, { dir })

  expect(path).not.toBeNull()
  expect(path).toBe(join(dir, 'bg_1234567890ab.json'))
  // Naming contract == auditPathForJob: `<job_id>.json` inside an `audit` dir.
  expect(basename(auditPathForJob('bg_1234567890ab'))).toBe('bg_1234567890ab.json')
  expect(auditPathForJob('bg_1234567890ab')).toContain(join('.omo', 'deepseek-delegate', 'audit'))

  const raw = readRecord(path!)
  const parsed = auditRecordSchema.safeParse(raw)
  expect(parsed.success).toBe(true)

  const record = parsed.success ? parsed.data : null
  expect(record).not.toBeNull()
  if (record === null) return
  expect(record.timestamp).toBe('2026-09-04T12:00:00.000Z')
  expect(record.preset).toBe('explore')
  expect(record.cwd).toBe(CWD)
  expect(record.session_id).toBe('ses_audit_happy_1')
  expect(record.job_id).toBe('bg_1234567890ab')
  expect(record.model).toBe('deepseek-v4-flash')
  expect(record.permission_mode).toBe('read-only')
  expect(record.image_paths).toEqual([])
  expect(record.context_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(record.env_allowlist_keys).toEqual([...ENV_ALLOWLIST])
  expect(record.helper_command).toBe('bun scripts/delegate-runner.ts --request bg_1234567890ab.request.json')
  expect(record.finish_reason).toBe('completed')
  expect(record.error_code).toBeUndefined()
  expect(record.error_message).toBeUndefined()
  expect(record.unrestricted_confirmation).toBe(false)
  expect(record.run_in_background).toBe(false)
  expect(record.network_caveat_v1).toBe(true)

  // Atomic write: only the record file exists — no .tmp residue.
  expect(readdirSync(dir).sort()).toEqual(['bg_1234567890ab.json'])
})

test('audit happy: record NEVER carries prompt/final_response content (metadata ledger, not a transcript)', () => {
  const dir = tmpDir()
  const distinctive = 'SUPER-SECRET-PROMPT-PHRASE-7f3c'
  const path = writeAuditFromResult(
    {
      input: exploreInput({ prompt: `do the thing: ${distinctive}` }),
      output: { ...completedOutput(), final_response: `the result: ${distinctive}` },
      startedAt: new Date(),
    },
    { dir },
  )
  const text = readFileSync(path!, 'utf8')
  expect(text).not.toContain(distinctive)
})

/* ------------------------------------------------------------------ */
/* failure: error outputs still produce audit records                  */
/* ------------------------------------------------------------------ */

test('audit failure path: error output → record with error_code + REDACTED message', () => {
  const dir = tmpDir()
  const startedAt = new Date('2026-09-04T12:30:00.000Z')
  const path = writeAuditFromResult(
    {
      input: exploreInput(),
      output: errorOutput(
        'AGENT_ERROR',
        'agent turn failed mid-run: sk-LIVE_SECRET_abc123def4567890 more detail',
        'bg_feedfacebead',
      ),
      startedAt,
    },
    { dir },
  )
  expect(path).not.toBeNull()
  const raw = readRecord(path!)
  const parsed = auditRecordSchema.safeParse(raw)
  expect(parsed.success).toBe(true)

  const record = parsed.success ? parsed.data : null
  if (record === null) return
  // Strict schema: the record carries only declared fields (no transcript).
  expect(record.job_id).toBe('bg_feedfacebead')
  expect(record.finish_reason).toBeUndefined()
  expect(record.error_code).toBe('AGENT_ERROR')
  expect(record.error_message).toContain('[REDACTED]')
  expect(record.error_message).not.toContain('sk-LIVE_SECRET')
  expect(record.error_message).toContain('agent turn failed mid-run')
  expect(record.error_message).not.toContain(AUDIT_TRUNCATION_MARKER) // short enough: not capped
  expect(record.unrestricted_confirmation).toBe(false)
})

test('audit failure path: preflight rejection (unrestricted without token) still writes a record', () => {
  const dir = tmpDir()
  const forged = {
    preset: 'unrestricted',
    prompt: 'run free',
    cwd: CWD,
    // confirm_unrestricted intentionally omitted
  }
  const gateOutput: DelegateOutput = {
    status: 'error',
    preset: 'unrestricted',
    model: 'deepseek-v4-flash',
    permission_mode: 'danger-full-access',
    error: {
      code: 'SCHEMA_INVALID',
      message: 'input violates the deepseek_delegate contract: confirm_unrestricted: preset "unrestricted" requires confirm_unrestricted === "I_UNDERSTAND_DSH_DANGER_FULL_ACCESS"',
    },
  }
  const path = writeAuditFromResult(
    { input: forged as unknown as Record<string, unknown>, output: gateOutput, startedAt: new Date() },
    { dir },
  )
  expect(path).not.toBeNull()

  const record = readRecord(path!)
  const parsed = auditRecordSchema.safeParse(record)
  expect(parsed.success).toBe(true)
  const data = parsed.success ? parsed.data : null
  if (data === null) return
  expect(data.preset).toBe('unrestricted')
  expect(data.permission_mode).toBe('danger-full-access') // identity of the ATTEMPTED preset
  expect(data.job_id).toBeUndefined() // never reached the job layer
  expect(data.helper_command).toBeUndefined() // nothing was ever spawned
  expect(data.error_code).toBe('SCHEMA_INVALID')
  expect(data.unrestricted_confirmation).toBe(false) // token NOT verified
  expect(data.run_in_background).toBe(false)
  // Preflight naming (no job id): the file is NOT `<something>/unrestricted.json`…
  expect(readdirSync(dir)).toHaveLength(1)
  expect(readdirSync(dir)[0]!.startsWith('preflight-')).toBe(true)
  expect(readdirSync(dir)[0]!.endsWith('.json')).toBe(true)
  // …and the audit file itself never contains the token string.
  expect(readFileSync(path!, 'utf8')).not.toContain(UNRESTRICTED_CONFIRMATION_TOKEN)
})

test('audit failure path: oversized error messages are capped with the truncation marker', () => {
  const dir = tmpDir()
  // Secret placed FIRST so it survives the cap and must be redacted.
  const longMessage = `sk-OVERLONG_SECRET_value987654321 boom: ${'x'.repeat(5000)}`
  const path = writeAuditFromResult(
    { input: exploreInput(), output: errorOutput('RUNNER_EXIT', longMessage, 'bg_cap000000001'), startedAt: new Date() },
    { dir },
  )
  const record = readRecord(path!)
  const message = record.error_message as string
  expect(message.length).toBeLessThanOrEqual(2000 + AUDIT_TRUNCATION_MARKER.length)
  expect(message.endsWith(AUDIT_TRUNCATION_MARKER)).toBe(true)
  expect(message).not.toContain('sk-OVERLONG_SECRET')
  expect(message).toContain('[REDACTED]')
})

/* ------------------------------------------------------------------ */
/* secret-leak guard                                                   */
/* ------------------------------------------------------------------ */

test('audit secrets: prompt/API-key material never reaches the file; hash + allowlist KEY NAMES do', () => {
  const dir = tmpDir()
  const fakeKey = 'sk-FAKE_LIVE_KEY_abcd1234wxyz9876'
  const literalKeyValue = 'dsh_literal_api_key_value_zzz999'
  const priorKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = literalKeyValue
  try {
    const secretPrompt = `use the key ${fakeKey} and also the literal ${literalKeyValue} to call the API`
    const path = writeAuditFromResult(
      {
        input: exploreInput({ prompt: secretPrompt }),
        output: errorOutput('AGENT_ERROR', `cannot authenticate: ${fakeKey} (literal ${literalKeyValue})`, 'bg_secret0001a'),
        startedAt: new Date(),
      },
      { dir },
    )
    expect(path).not.toBeNull()
    const text = readFileSync(path!, 'utf8')

    // The secret text and the literal key value never reach the ledger.
    expect(text).not.toContain(fakeKey)
    expect(text).not.toContain('sk-FAKE_LIVE_KEY')
    expect(text).not.toContain(literalKeyValue)
    expect(text).not.toContain(secretPrompt)

    // The one-way fingerprint and the allowlist KEY NAMES do.
    const expectedHash = createHash('sha256')
      .update(JSON.stringify({ prompt: secretPrompt }))
      .digest('hex')
    expect(text).toContain(expectedHash)
    for (const key of ENV_ALLOWLIST) expect(text).toContain(`"${key}"`)
    // …but never their VALUES: the redaction sweep must not have needed to
    // fire for the key name itself, and no value-shaped content exists.
    expect(text).not.toContain(`"DEEPSEEK_API_KEY": "`)
    expect(text).not.toContain(`"PATH": "`)
  } finally {
    if (priorKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = priorKey
  }
})

test('audit secrets: context_hash covers the effective body — vision blocks digest is stable and path-honest', () => {
  const dir = tmpDir()
  const pngPath = writePngFixture(dir)
  const visionInput: Record<string, unknown> = {
    preset: 'vision',
    prompt: 'Describe this image.',
    cwd: dir,
    images: [pngPath],
  }
  const visionOutput: DelegateOutput = {
    status: 'completed',
    preset: 'vision',
    job_id: 'bg_vision00001a',
    session_id: 'ses_audit_vision_1',
    model: 'deepseek-v4-flash-vision-exp',
    permission_mode: 'read-only',
    final_response: 'A tiny image.',
    finish_reason: 'completed',
  }
  const startedAt = new Date('2026-09-04T13:00:00.000Z')
  const path = writeAuditFromResult({ input: visionInput, output: visionOutput, startedAt }, { dir })

  // Distinct audit dir for the second write: buildAuditRecord is pure w.r.t.
  // context content, so two records from the same input share a hash even
  // though timestamps differ.
  const dir2 = tmpDir()
  const path2 = writeAuditFromResult(
    { input: visionInput, output: visionOutput, startedAt: new Date('2026-09-04T13:01:00.000Z') },
    { dir: dir2 },
  )

  const record = readRecord(path!)
  const record2 = readRecord(path2!)
  const parsed = auditRecordSchema.safeParse(record)
  expect(parsed.success).toBe(true)
  expect(record.image_paths).toEqual([pngPath])
  expect(record.context_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(record.context_hash).toBe(record2.context_hash)

  // The record holds PATHS only — never the image bytes.
  const text = readFileSync(path!, 'utf8')
  expect(text).toContain('tiny.png')
  const imageBytesHex = PNG_BYTES.toString('hex')
  expect(text).not.toContain(imageBytesHex)
  expect(text).not.toContain(Buffer.from(PNG_BYTES).toString('base64'))
})

/* ------------------------------------------------------------------ */
/* unrestricted marker                                                 */
/* ------------------------------------------------------------------ */

test('audit unrestricted: verified unrestricted run has marker true; token string never written', () => {
  const dir = tmpDir()
  const input: Record<string, unknown> = {
    preset: 'unrestricted',
    prompt: 'touch /tmp/anything',
    cwd: CWD,
    confirm_unrestricted: UNRESTRICTED_CONFIRMATION_TOKEN,
  }
  const output: DelegateOutput = {
    status: 'completed',
    preset: 'unrestricted',
    job_id: 'bg_unrestrict01',
    session_id: 'ses_audit_unrestricted_1',
    model: 'deepseek-v4-flash',
    permission_mode: 'danger-full-access',
    final_response: 'done',
    finish_reason: 'completed',
  }
  const path = writeAuditFromResult({ input, output, startedAt: new Date() }, { dir })
  expect(path).not.toBeNull()

  const record = readRecord(path!)
  const parsed = auditRecordSchema.safeParse(record)
  expect(parsed.success).toBe(true)
  const data = parsed.success ? parsed.data : null
  if (data === null) return
  expect(data.preset).toBe('unrestricted')
  expect(data.permission_mode).toBe('danger-full-access')
  expect(data.unrestricted_confirmation).toBe(true)
  expect(data.run_in_background).toBe(false)

  const text = readFileSync(path!, 'utf8')
  expect(text).not.toContain(UNRESTRICTED_CONFIRMATION_TOKEN)
  expect(text).toContain('"unrestricted_confirmation": true')
  expect(text).toContain('"network_caveat_v1": true')
})

test('audit unrestricted: marker stays false when the token is wrong (schema-rejected attempt)', () => {
  const dir = tmpDir()
  const wrongTokenInput = {
    preset: 'unrestricted',
    prompt: 'run free',
    cwd: CWD,
    confirm_unrestricted: 'I_UNDERSTAND_BUT_NOT_EXACTLY',
  }
  const gateOutput: DelegateOutput = {
    status: 'error',
    preset: 'unrestricted',
    model: 'deepseek-v4-flash',
    permission_mode: 'danger-full-access',
    error: { code: 'SCHEMA_INVALID', message: 'confirm_unrestricted mismatch' },
  }
  const record = buildAuditRecord({
    input: wrongTokenInput as unknown as Record<string, unknown>,
    output: gateOutput,
    startedAt: new Date(),
  })
  expect(record.unrestricted_confirmation).toBe(false)
  expect(record.error_code).toBe('SCHEMA_INVALID')
})

/* ------------------------------------------------------------------ */
/* strictness                                                          */
/* ------------------------------------------------------------------ */

test('audit strictness: records with unknown fields are rejected (changed_file_summary included)', () => {
  const record = buildAuditRecord({
    input: exploreInput(),
    output: completedOutput(),
    startedAt: new Date(),
  })

  // The canonical record parses…
  expect(auditRecordSchema.safeParse(record).success).toBe(true)

  // …and nothing else may sneak in.
  const withExtra = { ...record, unexpected_meta: 'nope' }
  expect(auditRecordSchema.safeParse(withExtra).success).toBe(false)

  // changed_file_summary is DELIBERATELY absent in v1 (not reliably
  // available); even a null placeholder is rejected by the strict schema.
  const withChangedFiles = { ...record, changed_file_summary: null }
  expect(auditRecordSchema.safeParse(withChangedFiles).success).toBe(false)

  // writeAudit refuses to persist an invalid record with a typed error.
  const dir = tmpDir()
  expect(() => writeAudit(withExtra as never, dir)).toThrow(AuditError)
  try {
    writeAudit(withExtra as never, dir)
    expect.unreachable('writeAudit must throw for an invalid record')
  } catch (error) {
    expect(error).toBeInstanceOf(AuditError)
    expect((error as AuditError).code).toBe('AUDIT_INVALID')
  }
  expect(readdirSync(dir)).toEqual([]) // nothing was written
})

test('audit strictness: network_caveat_v1 can only ever be true', () => {
  const record = buildAuditRecord({
    input: exploreInput(),
    output: completedOutput(),
    startedAt: new Date(),
  })
  const withFalseCaveat = { ...record, network_caveat_v1: false }
  expect(auditRecordSchema.safeParse(withFalseCaveat).success).toBe(false)
})

test('audit background: run_in_background:true attempt record is written with the job id naming', () => {
  const dir = tmpDir()
  const input = { ...exploreInput(), run_in_background: true }
  const running: DelegateOutput = {
    status: 'running',
    preset: 'explore',
    job_id: 'bg_bgstart0001a',
    model: 'deepseek-v4-flash',
    permission_mode: 'read-only',
  }
  const path = writeAuditFromResult({ input, output: running, startedAt: new Date() }, { dir })
  expect(path).not.toBeNull()
  const record = readRecord(path!)
  const parsed = auditRecordSchema.safeParse(record)
  expect(parsed.success).toBe(true)
  const data = parsed.success ? parsed.data : null
  if (data === null) return
  expect(data.run_in_background).toBe(true)
  expect(data.job_id).toBe('bg_bgstart0001a')
  expect(data.finish_reason).toBeUndefined() // attempt record: no outcome yet
  expect(data.error_code).toBeUndefined()
})

test('audit never throws: an un-buildable record yields null, not a crash', () => {
  const dir = tmpDir()
  const path = writeAuditFromResult(
    { input: exploreInput(), output: completedOutput(), startedAt: new Date() },
    { dir },
  )
  expect(path).not.toBeNull()
  // A record that cannot be validated (garbage output, no cwd) must yield
  // null under the never-throw contract — the tool result is untouched.
  const bad = writeAuditFromResult(
    { input: {}, output: {} as never, startedAt: new Date() },
    { dir },
  )
  expect(bad).toBeNull()
})

