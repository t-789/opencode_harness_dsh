#!/usr/bin/env bun
/**
 * DeepSeek Harness delegate bridge (executable entry).
 *
 * Reads ONE JSON request (argv `--request <json>` or a single stdin line),
 * launches the DSH JSON-RPC runtime as a child via the published TS SDK
 * client (`@deepseek-ai/dsh-sdk-client`'s `DeepSeekHarness`), runs one prompt
 * (or content-block list) on a fresh/named session, and prints exactly ONE
 * JSON result line to stdout:
 *
 *   success: { "ok": true,  "session_id": ..., "final_response": ...,
 *              "finish_reason": ..., "events_len": ... }            exit 0
 *   failure: { "ok": false, "error": { "code": ..., "message": ... } }
 *
 * Exit codes: 1 = agent/turn/transport errors; 2 = launch/preflight errors
 * (bad request, missing runtime bin, nonexistent cwd/config, launch failure).
 *
 * The child env is an explicit allowlist ONLY (`scripts/runner-lib.ts` ->
 * `ENV_ALLOWLIST`); the parent environment is never inherited wholesale.
 * Credential-shaped text is redacted before it can reach stdout.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { ContentBlock } from '@deepseek-ai/dsh-sdk-client'
import {
  BridgeError,
  DSH_RUNTIME_ENV_OVERRIDE,
  deriveFinishReason,
  parseRequestJson,
  redactSecrets,
  requestJsonFromArgv,
  resolveRuntimeBin,
  scrubEnv,
  type DelegateRequest,
} from './runner-lib.ts'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TIMEOUT_MS = 600_000
const EXIT_AGENT = 1
const EXIT_PREFLIGHT = 2
const EXIT_OK = 0

/** Overall-run budget exceeded (or a client-side per-request timeout). */
class BridgeTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeTimeoutError'
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Normalize an error into the wire `{ code, message }` payload (message redacted). */
function errorPayload(
  error: unknown,
  secretValues: readonly string[],
  fallbackCode: string,
  tagName = true,
): { code: string; message: string } {
  if (error instanceof BridgeError) {
    return { code: error.code, message: redactSecrets(error.message, secretValues) }
  }
  const err = asError(error)
  const detail = err instanceof BridgeTimeoutError
    ? `overall run budget exceeded: ${err.message}`
    : tagName && err.name !== 'Error'
      ? `${err.name}: ${err.message}`
      : err.message
  return { code: fallbackCode, message: redactSecrets(detail, secretValues) }
}

/** Classify an error raised while `run()` was in flight (agent/turn class, exit 1). */
function classifyRunError(error: unknown, secretValues: readonly string[]): { code: string; message: string } {
  if (error instanceof BridgeError) {
    return { code: error.code, message: redactSecrets(error.message, secretValues) }
  }
  const name = asError(error).name
  if (error instanceof BridgeTimeoutError || name === 'RequestTimeoutError') {
    return { code: 'TIMEOUT', message: redactSecrets(asError(error).message, secretValues) }
  }
  if (name === 'TransportClosedError' || name === 'SdkProtocolError') {
    return { code: 'TRANSPORT', message: redactSecrets(`${name}: ${asError(error).message}`, secretValues) }
  }
  return { code: 'AGENT_ERROR', message: redactSecrets(`${name}: ${asError(error).message}`, secretValues) }
}

/** Print the result line to stdout (fd-1 write is synchronous) and exit. */
function exitWith(payload: unknown, exitCode: number): never {
  writeSync(1, `${JSON.stringify(payload)}\n`)
  process.exit(exitCode)
}

/** Race a promise against an overall deadline (cleared on settlement). */
function withOverallTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BridgeTimeoutError(`overall run budget of ${timeoutMs} ms exceeded`)), timeoutMs)
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function ensureDirectory(label: string, path: string): void {
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(path)
  } catch {
    throw new BridgeError('PREFLIGHT', `${label} does not exist: ${path}`)
  }
  if (!stats.isDirectory()) {
    throw new BridgeError('PREFLIGHT', `${label} is not a directory: ${path}`)
  }
}

async function main(): Promise<void> {
  /* ---- 1. read + validate the request --------------------------------- */
  const argvJson = requestJsonFromArgv(process.argv.slice(2))
  let request: DelegateRequest
  try {
    const jsonText = argvJson ?? readFileSync(0, 'utf8')
    request = parseRequestJson(jsonText)
  } catch (error) {
    exitWith({ ok: false, error: errorPayload(error, [], 'BAD_REQUEST', false) }, EXIT_PREFLIGHT)
  }

  /* ---- 2. resolve paths + preflight checks (never spawns anything) ----- */
  const cwdAbs = resolve(request.cwd)
  const sessionRootAbs = resolve(request.session_root)
  const cordisAbs = resolve(request.cordis_config)
  let runtimeBin: string
  try {
    ensureDirectory('request cwd', cwdAbs)
    mkdirSync(sessionRootAbs, { recursive: true })
    if (!existsSync(cordisAbs)) {
      throw new BridgeError('PREFLIGHT', `cordis_config not found: ${cordisAbs}`)
    }
    runtimeBin = resolveRuntimeBin(process.env[DSH_RUNTIME_ENV_OVERRIDE], SCRIPTS_DIR)
  } catch (error) {
    exitWith({ ok: false, error: errorPayload(error, [], 'PREFLIGHT', false) }, EXIT_PREFLIGHT)
  }

  /* ---- 3. child env = explicit allowlist only -------------------------- */
  const childEnv = scrubEnv(process.env, {
    sessionRoot: sessionRootAbs,
    cordisConfig: cordisAbs,
    cwd: cwdAbs,
    permissionMode: request.permission_mode,
  })
  const timeoutMs = request.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const secretValues = process.env.DEEPSEEK_API_KEY === undefined ? [] : [process.env.DEEPSEEK_API_KEY]

  /* ---- 4. harness (launch spec, session route) ------------------------- */
  const harness = new DeepSeekHarness({
    launch: {
      command: 'node',
      args: [runtimeBin],
      cwd: cwdAbs,
      env: childEnv,
    },
    provider: request.provider,
    model: request.model,
    ...(request.max_tokens === undefined ? {} : { maxTokens: request.max_tokens }),
    cwd: cwdAbs,
  })

  /* ---- 5. signal handling: close the runtime, then exit ----------------- */
  let closed = false
  let exiting = false
  const closeHarness = async (): Promise<void> => {
    if (closed) return
    closed = true
    await harness.close()
  }
  const onSignal = (signal: NodeJS.Signals): void => {
    if (exiting) process.exit(EXIT_AGENT)
    exiting = true
    process.stderr.write(`delegate-runner: ${signal} received; closing harness\n`)
    void closeHarness().finally(() => process.exit(EXIT_AGENT))
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  /* ---- 6. launch handshake (launch-class failures exit 2) -------------- */
  try {
    await withOverallTimeout(harness.start(), timeoutMs)
  } catch (error) {
    await closeHarness()
    const err = asError(error)
    const isTimeout = error instanceof BridgeTimeoutError || err.name === 'RequestTimeoutError'
    exitWith(
      {
        ok: false,
        error: isTimeout
          ? { code: 'LAUNCH', message: `launch handshake timed out (${timeoutMs} ms budget)` }
          : errorPayload(error, secretValues, 'LAUNCH'),
      },
      EXIT_PREFLIGHT,
    )
  }

  /* ---- 7. run one prompt / content-block list -------------------------- */
  const input: string | ContentBlock[] =
    request.prompt ?? (request.content_blocks as unknown as ContentBlock[])
  const runOptions = request.session_id === undefined ? {} : { sessionId: request.session_id }

  let result: Awaited<ReturnType<typeof harness.run>>
  try {
    result = await withOverallTimeout(harness.run(input, runOptions), timeoutMs)
  } catch (error) {
    await closeHarness()
    exitWith({ ok: false, error: classifyRunError(error, secretValues) }, EXIT_AGENT)
  }
  await closeHarness()

  /* ---- 8. single JSON result line -------------------------------------- */
  exitWith(
    {
      ok: true,
      session_id: result.sessionId,
      final_response: redactSecrets(result.finalResponse, secretValues),
      finish_reason: deriveFinishReason(result.events),
      events_len: result.events.length,
    },
    EXIT_OK,
  )
}

void main().catch((error: unknown) => {
  // INTERNAL fallback: anything that escaped the structured paths above.
  exitWith(
    { ok: false, error: { code: 'INTERNAL', message: redactSecrets(asError(error).message) } },
    EXIT_AGENT,
  )
})
