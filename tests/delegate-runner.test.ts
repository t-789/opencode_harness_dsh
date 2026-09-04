/**
 * Tests for the DeepSeek Harness delegate bridge (plan todo 3).
 *
 * Credential-free: no live model calls, no DEEPSEEK_API_KEY requirement.
 * Unit tests import pure logic from `scripts/runner-lib.ts`; the preflight
 * failure test spawns the real entry (`scripts/delegate-runner.ts`) with an
 * invalid cwd and asserts exit 2, structured JSON on stdout, and that no
 * secret-shaped parent-env noise leaks into the child output.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
  import {
  ENV_ALLOWLIST,
  RequestParseError,
  RuntimeBinNotFoundError,
  deriveFinishReason,
  parseRequest,
  parseRequestJson,
  redactSecrets,
  resolveRuntimeBin,
  scrubEnv,
} from '../scripts/runner-lib.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = 'scripts/delegate-runner.ts'

/* ------------------------------------------------------------------ */
/* scrubEnv: allowlist only, values preserved, secrets/noise dropped   */
/* ------------------------------------------------------------------ */

const PARENT_WITH_NOISE: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/bridge-user',
  DEEPSEEK_API_KEY: 'sk-live-key-that-must-survive-123456',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.example/v1',
  // Secrets + ambient noise that must NEVER reach the child env:
  AWS_SECRET_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE-secret',
  OPENAI_API_KEY: 'sk-openai-noise-abcdef',
  NODE_OPTIONS: '--max-old-space-size=4096',
  DSH_SESSION_ROOT: '/ambient/dsh-root', // ambient DSH_* value → must be overridden/dropped
  DSH_NOISE: 'ambient-noise',
  DSH_CORDIS_CONFIG: '/ambient/cordis.yml',
  OTHER_APP_SECRET: 'do-not-copy',
}

const SCRUB_INPUTS = {
  sessionRoot: '/requested/session-root',
  cordisConfig: '/requested/cordis.yml',
  cwd: '/requested/cwd',
  permissionMode: 'workspace-write',
}

test('scrubEnv: output keys are exactly the allowlist; request values win', () => {
  const out = scrubEnv(PARENT_WITH_NOISE, SCRUB_INPUTS)
  const keys = Object.keys(out).sort()
  expect(keys).toEqual([...ENV_ALLOWLIST].sort())
  // Every allowlisted key is present (PATH/HOME/API key/base URL existed in parent).
  for (const key of ENV_ALLOWLIST) expect(out[key]).toBeDefined()
})

test('scrubEnv: preserves DEEPSEEK_API_KEY and forces DSH_* request values', () => {
  const out = scrubEnv(PARENT_WITH_NOISE, SCRUB_INPUTS)
  expect(out.DEEPSEEK_API_KEY).toBe('sk-live-key-that-must-survive-123456')
  expect(out.DSH_SESSION_ROOT).toBe('/requested/session-root') // NOT /ambient/dsh-root
  expect(out.DSH_CORDIS_CONFIG).toBe('/requested/cordis.yml') // NOT /ambient/cordis.yml
  expect(out.DSH_CWD).toBe('/requested/cwd')
  expect(out.DSH_PERMISSION_MODE).toBe('workspace-write') // forced from request inputs
  expect(out.PATH).toBe(PARENT_WITH_NOISE.PATH)
  expect(out.HOME).toBe(PARENT_WITH_NOISE.HOME)
  expect(out.DEEPSEEK_BASE_URL).toBe(PARENT_WITH_NOISE.DEEPSEEK_BASE_URL)
})

test('scrubEnv: drops unrelated secrets and ambient DSH_*/NODE_OPTIONS noise', () => {
  const out = scrubEnv(PARENT_WITH_NOISE, SCRUB_INPUTS)
  expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  expect(out.OPENAI_API_KEY).toBeUndefined()
  expect(out.NODE_OPTIONS).toBeUndefined()
  expect(out.OTHER_APP_SECRET).toBeUndefined()
  expect(out.DSH_NOISE).toBeUndefined()
  const json = JSON.stringify(out)
  expect(json).not.toContain('AKIA')
  expect(json).not.toContain('sk-openai')
  expect(json).not.toContain('ambient')
  expect(json).not.toContain('--max-old-space-size')
})

test('scrubEnv: copy-if-set keys are absent when the parent lacks them', () => {
  const out = scrubEnv(
    { HOME: '/h', DEEPSEEK_API_KEY: 'sk-set-12345678' }, // no PATH, no BASE_URL
    SCRUB_INPUTS,
  )
  expect(out.PATH).toBeUndefined()
  expect(out.DEEPSEEK_BASE_URL).toBeUndefined()
  expect(out.HOME).toBe('/h')
  expect(out.DEEPSEEK_API_KEY).toBe('sk-set-12345678')
  // The three request-forced slots are ALWAYS present.
  expect(out.DSH_SESSION_ROOT).toBe(SCRUB_INPUTS.sessionRoot)
  expect(out.DSH_CORDIS_CONFIG).toBe(SCRUB_INPUTS.cordisConfig)
  expect(out.DSH_CWD).toBe(SCRUB_INPUTS.cwd)
  expect(out.DSH_PERMISSION_MODE).toBe(SCRUB_INPUTS.permissionMode)
})

test('scrubEnv: never inherits ambient DSH_SESSION_ROOT when unrequested', () => {
  const out = scrubEnv({ DSH_SESSION_ROOT: '/ambient/leak', DEEPSEEK_API_KEY: 'sk-a-12345678' }, SCRUB_INPUTS)
  expect(out.DSH_SESSION_ROOT).toBe('/requested/session-root')
  expect(out.DSH_PERMISSION_MODE).toBe('workspace-write') // ambient-free: forced slot
})

/* ------------------------------------------------------------------ */
/* deriveFinishReason: last turn/end wins, never fabricates            */
/* ------------------------------------------------------------------ */

function turnEndEvent(kind: string, turn = 1): unknown {
  return { type: 'turn/end', data: { turn, reason: { kind } } }
}

test('finish_reason: derives from the last turn/end reason kind', () => {
  const events = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    turnEndEvent('completed', 1),
  ]
  expect(deriveFinishReason(events)).toBe('completed')
})

test('finish_reason: reports max-tokens from the final turn', () => {
  const events = [turnEndEvent('completed', 1), turnEndEvent('max-tokens', 2)]
  expect(deriveFinishReason(events)).toBe('max-tokens')
})

test('finish_reason: last turn/end wins even when an earlier one completed', () => {
  const events = [turnEndEvent('completed', 1), { type: 'agent/thinking', data: {} }, turnEndEvent('aborted', 2)]
  expect(deriveFinishReason(events)).toBe('aborted')
})

test('finish_reason: no turn/end event yields unknown (never fabricated completed)', () => {
  const events = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/start', data: { turn: 1 } },
  ]
  expect(deriveFinishReason(events)).toBe('unknown')
})

test('finish_reason: turn/end without a reason yields unknown', () => {
  expect(deriveFinishReason([{ type: 'turn/end', data: { turn: 1 } }])).toBe('unknown')
  expect(deriveFinishReason([{ type: 'turn/end' }])).toBe('unknown')
  expect(deriveFinishReason([])).toBe('unknown')
})

/* ------------------------------------------------------------------ */
/* parseRequest basics                                                 */
/* ------------------------------------------------------------------ */

test('parseRequestJson: defaults provider/model; rejects malformed input', () => {
  const req = parseRequestJson(
    JSON.stringify({
      prompt: 'hi',
      cwd: '/w',
      session_root: '/s',
      cordis_config: '/c/cordis.yml',
    }),
  )
  expect(req.provider).toBe('deepseek-official')
  expect(req.model).toBe('deepseek-v4-flash')
  expect(req.permission_mode).toBe('read-only') // default when absent
  expect(() => parseRequestJson('not json')).toThrow(RequestParseError)
  expect(() => parseRequest({ prompt: 'x' })).toThrow(RequestParseError) // missing required fields
  expect(() => parseRequest({ prompt: 'x', content_blocks: [{ type: 'text', text: 'y' }], cwd: '/w', session_root: '/s', cordis_config: '/c' })).toThrow(RequestParseError) // both prompt + blocks
  expect(() => parseRequest({ content_blocks: [], cwd: '/w', session_root: '/s', cordis_config: '/c' })).toThrow(RequestParseError)
})

test('parseRequest: accepts the three permission modes; rejects anything else', () => {
  const base = { prompt: 'hi', cwd: '/w', session_root: '/s', cordis_config: '/c' }
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    expect(parseRequest({ ...base, permission_mode: mode }).permission_mode).toBe(mode)
  }
  expect(() => parseRequest({ ...base, permission_mode: 'admin' })).toThrow(RequestParseError)
  expect(() => parseRequest({ ...base, permission_mode: 42 })).toThrow(RequestParseError)
  expect(() => parseRequest({ ...base, permission_mode: '' })).toThrow(RequestParseError)
})

test('redactSecrets: credential-shaped tokens and literal secrets are removed', () => {
  const out = redactSecrets('key=sk-abcdefghijklmnop failed for AKIAIOSFODNN7EXAMPLE', ['sk-literal-secret-value'])
  expect(out).not.toContain('sk-abcdefghijklmnop')
  expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
  expect(out).toContain('[REDACTED]')
  expect(redactSecrets('literal sk-literal-secret-value here')).toContain('[REDACTED]')
})

/* ------------------------------------------------------------------ */
/* Preflight failure (real entry, child process, exit 2, no secrets)   */
/* ------------------------------------------------------------------ */

const SECRET_API_KEY = 'sk-fake-preflight-secret-7777777777'
const AWS_NOISE = 'AKIAFAKEAWSKEY1234567'

function runEntry(request: Record<string, unknown>): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, ENTRY, '--request', JSON.stringify(request)],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: SECRET_API_KEY,
      AWS_SECRET_ACCESS_KEY: AWS_NOISE,
      OPENAI_API_KEY: 'sk-openai-noise-zzzz',
      NODE_OPTIONS: '--max-old-space-size=4096',
      DSH_NOISE: 'ambient-dsh-noise',
    },
  })
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

test('preflight: nonexistent cwd exits 2 with structured JSON and leaks no secrets', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'delegate-runner-test-'))
  try {
    const { exitCode, stdout, stderr } = runEntry({
      prompt: 'list the repo',
      cwd: join(tmp, 'does-not-exist'),
      session_root: join(tmp, 'sessions'),
      cordis_config: join(tmp, 'cordis.yml'),
    })
    expect(exitCode).toBe(2)
    // stdout is exactly one JSON line
    const lines = stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    const payload = JSON.parse(stdout) as { ok: boolean; error: { code: string; message: string } }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('PREFLIGHT')
    expect(payload.error.message).toContain('cwd')
    expect(payload.error.message).toContain('does-not-exist')
    // no credential-shaped or ambient noise anywhere on stdout or stderr
    const combined = stdout + stderr
    expect(combined).not.toContain(SECRET_API_KEY)
    expect(combined).not.toContain(AWS_NOISE)
    expect(combined).not.toContain('sk-openai-noise')
    expect(combined).not.toContain('ambient-dsh-noise')
    expect(combined).not.toContain('--max-old-space-size')
    // and the request payload was NOT echoed back wholesale
    expect(stdout).not.toContain('list the repo')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('preflight: missing cordis_config exits 2 with PREFLIGHT and mentions the file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'delegate-runner-test-'))
  try {
    const missingConfig = join(tmp, 'no-such-cordis.yml')
    const { exitCode, stdout } = runEntry({
      prompt: 'hi',
      cwd: tmp, // real directory → passes the cwd check
      session_root: join(tmp, 'sessions'),
      cordis_config: missingConfig,
    })
    expect(exitCode).toBe(2)
    const payload = JSON.parse(stdout) as { ok: boolean; error: { code: string; message: string } }
    expect(payload.ok).toBe(false)
    expect(payload.error.code).toBe('PREFLIGHT')
    expect(payload.error.message).toContain('cordis_config')
    expect(stdout).not.toContain(SECRET_API_KEY)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* Runtime bin resolution                                              */
/* ------------------------------------------------------------------ */

test('runtime bin resolves to an existing file under node_modules (installed dep)', () => {
  const bin = resolveRuntimeBin(undefined, join(REPO_ROOT, 'scripts'))
  expect(bin).toBe(join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js'))
})

test('runtime bin: DSH_RUNTIME_BIN override pointing at a missing file throws PREFLIGHT', () => {
  expect(() => resolveRuntimeBin('/no/such/runtime-bin.js', REPO_ROOT)).toThrow(RuntimeBinNotFoundError)
})
