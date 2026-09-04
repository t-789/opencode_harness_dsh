/**
 * Preset → runtime mapping tests for deepseek_delegate (plan todo 5).
 *
 * Table-driven over the four presets: each canonical validated input must map
 * to EXACT bridge request fields (model, permission_mode, composition,
 * session_root, cordis_config, provider, cwd) plus metadata the tool execute
 * path uses. Mapping-layer guards (vision images unresolved, unrestricted
 * token missing, malformed/foreign content_blocks, forged model/permission
 * escapes) are asserted as failures — never reaching a runner/helper.
 *
 * Credential-free and fs-free: mapping performs no file checks and no spawns.
 */
import { describe, expect, test } from "bun:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseRequest, type DelegateRequest } from "../scripts/runner-lib.ts"
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

const VISION_PROMPT = "What is in this diagram?"
const IMAGE_PATHS = ["/tmp/diagram.png", "/tmp/photo.png"]

/** Pre-assembled content blocks in the exact shape todo 9 will produce. */
const VISION_BLOCKS = [
  { type: "text", text: VISION_PROMPT },
  { type: "image", path: IMAGE_PATHS[0] },
  { type: "image", path: IMAGE_PATHS[1] },
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
  preset: "explore" | "write" | "vision" | "unrestricted"
  build: BuildBridgeRequestInput
  /** Schema-derived expectations (single source of truth: resolvePresetDefaults). */
  expectModel: DelegateModel
  expectPermission: PermissionMode
  expectComposition: "base" | "vision"
  /** Body assertions. */
  expectPrompt?: string
  expectBlocks?: unknown[]
  /** Optional-field passthrough assertions. */
  sessionId?: string
  maxTokens?: number
  timeoutMs?: number
  /** Metadata assertions. */
  hasContextPacket?: boolean
  imagePaths?: readonly string[]
}

/* ------------------------------------------------------------------ */
/* Table rows: one canonical valid input per preset + overrides        */
/* ------------------------------------------------------------------ */

const rows: Row[] = [
  {
    name: "explore -> deepseek-v4-flash / read-only / base.cordis.yml, prompt passthrough",
    preset: "explore",
    build: {
      input: validInput({ preset: "explore", prompt: PROMPT, cwd: TARGET_CWD }),
    },
    expectModel: "deepseek-v4-flash",
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
    expectModel: "deepseek-v4-flash",
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
    expectModel: "deepseek-v4-flash",
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
    expectModel: "deepseek-v4-flash",
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
    expectModel: "deepseek-v4-flash",
    expectPermission: "workspace-write",
    expectComposition: "base",
    expectPrompt: PROMPT,
    hasContextPacket: false,
  },
  {
    name: "vision (default read-only) -> vision-exp / read-only / vision.cordis.yml; blocks injected verbatim",
    preset: "vision",
    build: {
      input: validInput({
        preset: "vision",
        prompt: VISION_PROMPT,
        cwd: TARGET_CWD,
        images: IMAGE_PATHS,
      }),
      content_blocks: VISION_BLOCKS,
    },
    expectModel: "deepseek-v4-flash-vision-exp",
    expectPermission: "read-only",
    expectComposition: "vision",
    expectBlocks: VISION_BLOCKS,
    imagePaths: IMAGE_PATHS,
  },
  {
    name: "vision (explicit workspace-write override) -> workspace-write + vision stack",
    preset: "vision",
    build: {
      input: validInput({
        preset: "vision",
        prompt: VISION_PROMPT,
        cwd: TARGET_CWD,
        images: IMAGE_PATHS,
        permission_mode: "workspace-write",
      }),
      resolved_images: IMAGE_PATHS.map((path) => ({ path })),
      content_blocks: VISION_BLOCKS,
    },
    expectModel: "deepseek-v4-flash-vision-exp",
    expectPermission: "workspace-write",
    expectComposition: "vision",
    expectBlocks: VISION_BLOCKS,
    imagePaths: IMAGE_PATHS,
  },
  {
    name: "vision with admission output (resolved_images) but schema-raw images equal -> image_paths metadata from admission",
    preset: "vision",
    build: {
      input: validInput({
        preset: "vision",
        prompt: VISION_PROMPT,
        cwd: TARGET_CWD,
        images: [IMAGE_PATHS[0]],
      }),
      resolved_images: [{ path: IMAGE_PATHS[0] }],
      content_blocks: [{ type: "image", path: IMAGE_PATHS[0] }],
    },
    expectModel: "deepseek-v4-flash-vision-exp",
    expectPermission: "read-only",
    expectComposition: "vision",
    expectBlocks: [{ type: "image", path: IMAGE_PATHS[0] }],
    imagePaths: [IMAGE_PATHS[0]],
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
    expectModel: "deepseek-v4-flash",
    expectPermission: "danger-full-access",
    expectComposition: "base",
    expectPrompt: PROMPT,
  },
]

/* ------------------------------------------------------------------ */
/* Shared assertions per row                                           */
/* ------------------------------------------------------------------ */

function expectExactlyOneBody(request: DelegateRequest): void {
  const hasPrompt = request.prompt !== undefined
  const hasBlocks = request.content_blocks !== undefined
  expect(hasPrompt).not.toBe(hasBlocks)
}

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

  // 6) body: exactly one of prompt/content_blocks, with the expected payload.
  expectExactlyOneBody(request)
  if (row.expectPrompt !== undefined) {
    expect(request.content_blocks).toBeUndefined()
    expect(request.prompt).toBe(row.expectPrompt)
  } else {
    expect(request.prompt).toBeUndefined()
    expect(request.content_blocks).toEqual(row.expectBlocks)
    expect(request.content_blocks).toHaveLength(row.expectBlocks!.length)
  }

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
  expect(metadata.uses_content_blocks).toBe(row.expectBlocks !== undefined)
  if (row.imagePaths === undefined) expect(metadata.image_paths).toEqual([])
  else expect(metadata.image_paths).toEqual(row.imagePaths)

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
  test("vision with a forged danger-full-access override (schema would reject it) maps read-only when blocks are resolved", () => {
    // zod's strictObject + superRefine reject this input upstream (schema
    // tests assert that); a caller that bypasses safeParse with a forged
    // object must STILL not escalate: resolvePresetDefaults fails closed.
    const forged = {
      preset: "vision",
      prompt: VISION_PROMPT,
      cwd: TARGET_CWD,
      images: IMAGE_PATHS,
      permission_mode: "danger-full-access",
    } as unknown as DelegateInput
    const built = buildBridgeRequestWithMetadata({
      input: forged,
      content_blocks: VISION_BLOCKS,
    })
    expect(built.metadata.permission_mode).toBe("read-only")
    expect(built.request.permission_mode).toBe("read-only")
    expect(built.request.model).toBe("deepseek-v4-flash-vision-exp")
    expect(built.metadata.permission_mode).toBe(resolvePresetDefaults("vision", forged.permission_mode).permission_mode)
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
    expect(built.request.model).toBe("deepseek-v4-flash")
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
  test("vision without resolved content_blocks fails closed and names the dropped image paths", () => {
    const { code, message } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "vision", prompt: VISION_PROMPT, cwd: TARGET_CWD, images: IMAGE_PATHS }),
      }),
    )
    expect(code).toBe("VISION_IMAGES_UNRESOLVED")
    expect(message).toContain(IMAGE_PATHS[0])
    expect(message).toContain(IMAGE_PATHS[1])
    expect(message).toContain("prompt-only")
  })

  test("vision with admission output but still no content_blocks fails closed on the admitted paths", () => {
    const { code, message } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "vision", prompt: VISION_PROMPT, cwd: TARGET_CWD, images: [IMAGE_PATHS[0]] }),
        resolved_images: [{ path: IMAGE_PATHS[0] }],
      }),
    )
    expect(code).toBe("VISION_IMAGES_UNRESOLVED")
    expect(message).toContain(IMAGE_PATHS[0])
  })

  test("empty content_blocks array is rejected (wire contract needs >= 1 block)", () => {
    const { code } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "vision", prompt: VISION_PROMPT, cwd: TARGET_CWD, images: IMAGE_PATHS }),
        content_blocks: [],
      }),
    )
    expect(code).toBe("INVALID_CONTENT_BLOCKS")
  })

  test("content_blocks with a block lacking a string type is rejected", () => {
    const { code } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "vision", prompt: VISION_PROMPT, cwd: TARGET_CWD, images: IMAGE_PATHS }),
        content_blocks: [{ path: IMAGE_PATHS[0] }] as unknown as { type: string }[],
      }),
    )
    expect(code).toBe("INVALID_CONTENT_BLOCKS")
  })

  test("content_blocks on a non-vision preset is rejected", () => {
    const { code, message } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "explore", prompt: PROMPT, cwd: TARGET_CWD }),
        content_blocks: VISION_BLOCKS,
      }),
    )
    expect(code).toBe("BLOCKS_ON_TEXT_PRESET")
    expect(message).toContain("explore")
  })

  test("vision with both content_blocks and rendered_prompt is rejected as ambiguous", () => {
    const { code } = mappingErrorCode(() =>
      buildBridgeRequest({
        input: validInput({ preset: "vision", prompt: VISION_PROMPT, cwd: TARGET_CWD, images: IMAGE_PATHS }),
        rendered_prompt: VISION_PROMPT,
        content_blocks: VISION_BLOCKS,
      }),
    )
    expect(code).toBe("AMBIGUOUS_REQUEST_BODY")
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
