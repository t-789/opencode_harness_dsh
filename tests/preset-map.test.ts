/**
 * Preset → runtime mapping tests for deepseek_delegate (plan todo 5).
 *
 * Table-driven over the three callable presets: each canonical validated input
 * must map to EXACT bridge request fields (model, permission_mode, composition,
 * session_root, cordis_config, provider, cwd) plus metadata the tool execute
 * path uses. Mapping-layer guards (the disabled vision preset, unrestricted
 * token missing, malformed/stale content_blocks, forged model/permission
 * escapes) are asserted as failures — never reaching a runner/helper.
 *
 * Credential-free and fs-free: mapping performs no file checks and no spawns.
 */
import { describe, expect, test } from "bun:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseRequest } from "../scripts/runner-lib.ts"
import {
  DELEGATE_MODELS,
  PERMISSION_MODES,
  UNRESTRICTED_CONFIRMATION_TOKEN,
  deepseekDelegateInputSchema,
resolvePresetDefaults,
  type DelegateInput,
  type DelegateModel,
type PermissionMode,
} from "../src/schema"
import {
  CORDIS_CONFIG_DIR,
  CORDIS_CONFIG_PATH,
  PresetMappingError,
  PROJECT_ROOT,
  SESSION_ROOT,
  buildBridgeRequest,
  buildBridgeRequestWithMetadata,
  type BuildBridgeRequestInput,
  type BuiltBridgeRequest,
} from "../src/preset-map"

/** Tool project root (the repo that owns `.omo` state). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
expect(ROOT).toBe(PROJECT_ROOT)

/**
 * Delegation target that is deliberately NOT this tool's project, proving
 * session_root stays project-owned instead of being derived from the cwd.
 */
const TARGET_CWD = "/Users/liuzy/some-other-target-repo"
const PROMPT = "Do the delegated task"

const writePacket = {
  objective: "Add a verify command to the harness",
  repo_summary: "Small opencode custom-tool repo.",
  relevant_paths: ["src/schema.ts", "tests/schema.test.ts"],
  constraints: "Keep zod at 4.x. No new npm deps.",
  expected_changes: "src/schema.ts and tests/schema.test.ts updated; no other files touched.",
  verification_commands: ["bun test tests/schema.test.ts"],
  non_goals: "No DSH source edits.",
}

/** Stale content blocks in the shape the removed vision path used to assemble. */
const STALE_CONTENT_BLOCKS = [
  { type: "text", text: "What is in this diagram?" },
  { type: "image", path: "/tmp/diagram.png" },
  { type: "image", path: "/tmp/photo.png" },
]

function validInput(raw: Record<string, unknown>): DelegateInput {
  const result = deepseekDelegateInputSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(`test fixture failed the schema: ${JSON.stringify(result.error.issues)}`)
  }
  return result.data
}

interface Row {
  name: string
  preset: "explore" | "write" | "unrestricted"
  build: BuildBridgeRequestInput
  /** Schema-derived expectations (single source of truth: resolvePresetDefaults). */
  expectModel: DelegateModel
  expectPermission: PermissionMode
  expectComposition: "base"
  /** Body assertion: every live preset maps exactly one prompt. */
  expectPrompt: string
  /** Optional-field passthrough assertions. */
  sessionId?: string
  maxTokens?: number
  timeoutMs?: number
  /** Metadata assertions. */
  hasContextPacket?: boolean
}

/* ------------------------------------------------------------------ */
/* Table rows: one canonical valid input per preset + overrides        */
/* ------------------------------------------------------------------ */

const rows: Row[] = [
  {
    name: "explore -> deepseek-flash / read-only / base.cordis.yml, prompt passthrough",
    preset: "explore",
    build: {
      input: validInput({ preset: "explore", prompt: PROMPT, cwd: TARGET_CWD }),
    },
    expectModel: "deepseek-flash",
    expectPermission: "read-only",
    expectComposition: "base",
    expectPrompt: PROMPT,
  },
  {
    name: "explore passes session_id/max_tokens/timeout_ms through when present and omits them when absent",
    preset: "explore",
    build: {
      input: validInput({
        preset: "explore",
        prompt: PROMPT,
        cwd: TARGET_CWD,
        session_id: "ses_followup_1",
        max_tokens: 2048,
        timeout_ms: 90_000,
      }),
    },
    expectModel: "deepseek-flash",
    expectPermission: "read-only",
    expectComposition: "base",
    expectPrompt: PROMPT,
    sessionId: "ses_followup_1",
    maxTokens: 2048,
    timeoutMs: 90_000,
  },
  {
    name: "write (context_packet) -> workspace-write / base; packet presence mapped, raw prompt passthrough",
    preset: "write",
    build: {
      input: validInput({
        preset: "write",
        prompt: PROMPT,
        cwd: TARGET_CWD,
        context_packet: writePacket,
      }),
    },
    expectModel: "deepseek-flash",
    expectPermission: "workspace-write",
    expectComposition: "base",
    expectPrompt: PROMPT,
    hasContextPacket: true,
  },
  {
    name: "write (context_packet) + rendered_prompt seam -> the rendered text becomes request.prompt (todo 6 hook)",
    preset: "write",
    build: {
      input: validInput({
        preset: "write",
        prompt: PROMPT,
        cwd: TARGET_CWD,
        context_packet: writePacket,
      }),
      rendered_prompt: "[CONTEXT]\nobjective: Add a verify command to the harness\n[END CONTEXT]\n" + PROMPT,
    },
    expectModel: "deepseek-flash",
    expectPermission: "workspace-write",
    expectComposition: "base",
    expectPrompt: "[CONTEXT]\nobjective: Add a verify command to the harness\n[END CONTEXT]\n" + PROMPT,
    hasContextPacket: true,
  },
  {
    name: "write (allow_auto_context, no packet) -> workspace-write / base; no context packet metadata",
    preset: "write",
    build: {
      input: validInput({
        preset: "write",
        prompt: PROMPT,
        cwd: TARGET_CWD,
        allow_auto_context: true,
      }),
    },
    expectModel: "deepseek-flash",
    expectPermission: "workspace-write",
    expectComposition: "base",
    expectPrompt: PROMPT,
    hasContextPacket: false,
  },
  {
    name: "unrestricted (exact token) -> danger-full-access / base.cordis.yml",
    preset: "unrestricted",
    build: {
      input: validInput({
        preset: "unrestricted",
        prompt: PROMPT,
        cwd: TARGET_CWD,
        confirm_unrestricted: UNRESTRICTED_CONFIRMATION_TOKEN,
      }),
    },
    expectModel: "deepseek-flash",
    expectPermission: "danger-full-access",
    expectComposition: "base",
    expectPrompt: PROMPT,
  },
]

/* ------------------------------------------------------------------ */
/* Shared assertions per row                                           */
/* ------------------------------------------------------------------ */

function assertRow(built: BuiltBridgeRequest, row: Row): void {
  const { request, metadata } = built

  // 1) permission_mode is EXACTLY one of the three fixed modes (never free text).
  expect(PERMISSION_MODES).toContain(request.permission_mode)
  expect(PERMISSION_MODES).toContain(metadata.permission_mode)

  // 2) model/permission are the SCHEMA-derived values (resolvePresetDefaults is
  //    the single source of truth; the mapping must track it, not its own copy).
  const schemaDefaults = resolvePresetDefaults(row.preset, row.build.input.permission_mode)
  expect(request.model).toBe(schemaDefaults.model)
  expect(request.permission_mode).toBe(schemaDefaults.permission_mode)
  expect(request.model).toBe(row.expectModel)
  expect(request.permission_mode).toBe(row.expectPermission)

  // 3) no arbitrary model escapes: derived models are always within the
  //    delegate model catalog and never equal a forged candidate.
  expect([...DELEGATE_MODELS] as string[]).toContain(request.model)

  // 4) fixed bridge fields.
  expect(request.provider).toBe("deepseek-official")
  expect(request.cwd).toBe(resolve(TARGET_CWD))
  expect(request.session_root).toBe(SESSION_ROOT)
  expect(SESSION_ROOT).toBe(join(ROOT, ".omo", "deepseek-delegate", "sessions"))
  expect(request.cordis_config).toBe(CORDIS_CONFIG_PATH[row.expectComposition])
  expect(request.cordis_config.startsWith(CORDIS_CONFIG_DIR)).toBe(true)
  expect(request.cordis_config).toBe(join(CORDIS_CONFIG_DIR, `${row.expectComposition}.cordis.yml`))

  // 5) session_root is project-owned, never derived from the delegation cwd.
  expect(request.session_root.startsWith(TARGET_CWD)).toBe(false)

  // 6) body: every live preset maps exactly one prompt (the vision
  //    content-block path was removed with the model merge).
  expect(request.content_blocks).toBeUndefined()
  expect(request.prompt).toBe(row.expectPrompt)

  // 7) optional passthrough fields.
  if (row.sessionId === undefined) expect(request.session_id).toBeUndefined()
  else expect(request.session_id).toBe(row.sessionId)
  if (row.maxTokens === undefined) expect(request.max_tokens).toBeUndefined()
  else expect(request.max_tokens).toBe(row.maxTokens)
  if (row.timeoutMs === undefined) expect(request.timeout_ms).toBeUndefined()
  else expect(request.timeout_ms).toBe(row.timeoutMs)

  // 8) metadata facts.
  expect(metadata.preset).toBe(row.preset)
  expect(metadata.model).toBe(row.expectModel)
  expect(metadata.permission_mode).toBe(row.expectPermission)
  expect(metadata.composition).toBe(row.expectComposition)
  expect(metadata.cwd).toBe(request.cwd)
  expect(metadata.session_root).toBe(SESSION_ROOT)
  expect(metadata.cordis_config).toBe(request.cordis_config)
  expect(metadata.has_context_packet).toBe(row.hasContextPacket ?? false)
  expect(metadata.uses_content_blocks).toBe(false)
  expect(metadata.image_paths).toEqual([])

  // 9) wire round trip: the built request survives the bridge's own parser
  //    (JSON serialization drops undefined optionals, exactly like the spawn
  //    path in the tool execute flow).
  const viaWire = parseRequest(JSON.parse(JSON.stringify(request)))
  expect(viaWire).toEqual(request)
}

describe("preset mapping happy paths (table-driven)", () => {
  for (const row of rows) {
    test(row.name, () => {
      assertRow(buildBridgeRequestWithMetadata(row.build), row)
      // The metadata-less entry returns exactly the same request object.
      expect(buildBridgeRequest(row.build)).toEqual(buildBridgeRequestWithMetadata(row.build).request)
    })
  }
})

/* ------------------------------------------------------------------ */
/* resolvePresetDefaults integration                                   */
/* ------------------------------------------------------------------ */

describe("mapping honors the schema-derived permission mode (fail closed)", () => {
  test("forged vision input is rejected by the mapping guard (never selects the removed model)", () => {
    // The schema rejects vision with the deprecation message; a caller that
    // bypasses safeParse must STILL not reach a model or a composition.
    const forged = {
      preset: "vision",
      prompt: "describe this image",
      cwd: TARGET_CWD,
      images: ["/tmp/diagram.png"],
      permission_mode: "danger-full-access",
    } as unknown as DelegateInput
    const { code, message } = mappingErrorCode(() =>
      buildBridgeRequestWithMetadata({ input: forged, content_blocks: STALE_CONTENT_BLOCKS }),
    )
    expect(code).toBe("VISION_PRESET_DISABLED")
    expect(message).toContain("deepseek-flash")
    expect(message).toContain("use explore")
    expect(resolvePresetDefaults("vision").model).toBe("deepseek-flash")
  })

  test("explore with a redundant read-only override maps read-only (its preset default)", () => {
    const built = buildBridgeRequestWithMetadata({
      input: validInput({
        preset: "explore",
        prompt: PROMPT,
        cwd: TARGET_CWD,
        permission_mode: "read-only",
      }),
    })
    expect(built.request.permission_mode).toBe("read-only")
  })

  test("a forged model key on the input object can never reach the request (model keys are never read)", () => {
    // The typed input cannot carry `model`; a runtime-forged key must still be
    // ignored because the mapping derives the model exclusively from the preset.
    const raw = validInput({ preset: "explore", prompt: PROMPT, cwd: TARGET_CWD })
    Object.assign(raw, { model: "gpt-4o", provider: "anthropic" })
    const built = buildBridgeRequestWithMetadata({ input: raw })
    expect(built.request.model).toBe("deepseek-flash")
    expect(built.request.provider).toBe("deepseek-official")
    expect(JSON.stringify(built.request)).not.toContain("gpt-4o")
    expect(JSON.stringify(built.request)).not.toContain("anthropic")
  })
})

/* ------------------------------------------------------------------ */
/* Mapping-layer guard failures (no runner/helper ever invoked)        */
/* ------------------------------------------------------------------ */

function mappingErrorCode(fn: () => unknown): { code: string; message: string } {
  try {
    fn()
  } catch (error) {
    if (error instanceof PresetMappingError) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error("expected a PresetMappingError but the mapping succeeded")
}

describe("preset mapping failure paths (guards fire before any helper spawn)", () => {
  test("empty content_blocks array is rejected (wire contract needs >= 1 block)", () => {
    const { code } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "explore", prompt: PROMPT, cwd: TARGET_CWD }),
        content_blocks: [],
      }),
    )
    expect(code).toBe("INVALID_CONTENT_BLOCKS")
  })

  test("content_blocks with a block lacking a string type is rejected", () => {
    const { code } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "explore", prompt: PROMPT, cwd: TARGET_CWD }),
        content_blocks: [{ path: "/tmp/diagram.png" }] as unknown as { type: string }[],
      }),
    )
    expect(code).toBe("INVALID_CONTENT_BLOCKS")
  })

  test("content_blocks on any live preset is rejected (the vision route was removed)", () => {
    const { code, message } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "explore", prompt: PROMPT, cwd: TARGET_CWD }),
        content_blocks: STALE_CONTENT_BLOCKS,
      }),
    )
    expect(code).toBe("BLOCKS_ON_TEXT_PRESET")
    expect(message).toContain("explore")
    expect(message).toContain("vision preset")
  })

  test("unrestricted without the confirmation token is rejected at the mapping layer (type makes it optional)", () => {
    // DelegateInput.confirm_unrestricted is optional, so a caller that builds
    // the typed object without safeParse could omit it; the mapping is the
    // last gate before danger-full-access is derived. (safeParse itself also
    // rejects this input — the schema tests assert that path.)
    const raw = { preset: "unrestricted", prompt: PROMPT, cwd: TARGET_CWD } as unknown as DelegateInput
    const { code, message } = mappingErrorCode(() => buildBridgeRequest({ input: raw }))
    expect(code).toBe("UNRESTRICTED_CONFIRMATION_REQUIRED")
    expect(message).toContain(UNRESTRICTED_CONFIRMATION_TOKEN)
  })

  test("unrestricted with a wrong confirmation token is rejected at the mapping layer", () => {
    const raw = validInput({
      preset: "unrestricted",
      prompt: PROMPT,
      cwd: TARGET_CWD,
      confirm_unrestricted: UNRESTRICTED_CONFIRMATION_TOKEN,
    })
    // Replace the token AFTER schema validation: the wrong-token input never
    // reaches the mapping (schema rejects it first); the mapping guard exists
    // for callers that construct typed objects without safeParse.
    Object.assign(raw, { confirm_unrestricted: "maybe?" })
    const { code } = mappingErrorCode(() => buildBridgeRequest({ input: raw }))
    expect(code).toBe("UNRESTRICTED_CONFIRMATION_REQUIRED")
  })
})
