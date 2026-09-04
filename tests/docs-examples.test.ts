/**
 * README example guard (plan todo 12).
 *
 * The README is the user-facing source of truth for deepseek_delegate usage. Every
 * fenced code block it carries under a json info-string is machine-checked here:
 *
 *   ```json delegate         tool arguments that MUST pass deepseekDelegateInputSchema
 *                            (one valid example per preset, sync + background, the
 *                            write context_packet and allow_auto_context forms, and
 *                            the vision image forms)
 *   ```json delegate-invalid tool arguments that MUST be rejected (the documented
 *                            unrestricted-without-token and vague-write examples)
 *   ```json output           DelegateOutput envelopes that MUST pass
 *                            deepseekDelegateOutputSchema
 *   ```json                  plain JSON (companion args/results): must parse; job ids
 *                            must match the real bg_ id pattern
 *
 * Plus content guards: the README must state the v1 network limitation and the exact
 * unrestricted confirmation token (the plan's task-12 failure QA criterion).
 *
 * Credential-free: pure string + schema work, no DSH runtime, no API calls.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  UNRESTRICTED_CONFIRMATION_TOKEN,
  deepseekDelegateInputSchema,
  deepseekDelegateOutputSchema,
  type DelegateInput,
} from "../src/schema.ts"

const README_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md")
const README = readFileSync(README_PATH, "utf8")

/** Fenced ```json <tag> blocks (tag may be absent for plain json). */
function fences(tag: string | null): string[] {
  const out: string[] = []
  const pattern = /```json([^\n]*)\n([\s\S]*?)```/g
  for (const match of README.matchAll(pattern)) {
    const info = (match[1] ?? "").trim()
    const body = match[2] ?? ""
    const matchesTag = tag === null ? info === "" : info === tag
    if (matchesTag) out.push(body)
  }
  return out
}

function parseJson(block: string, where: string): unknown {
  try {
    return JSON.parse(block)
  } catch (error) {
    throw new Error(`${where}: example is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ------------------------------------------------------------------ */
/* Valid tool-argument examples                                        */
/* ------------------------------------------------------------------ */

const validBlocks = fences("delegate")
const invalidBlocks = fences("delegate-invalid")
const outputBlocks = fences("output")
const plainBlocks = fences(null)

test("README documents valid examples for all four presets", () => {
  const presets = new Set<string>()
  for (const block of validBlocks) {
    const args = parseJson(block, "json delegate") as DelegateInput
    const parsed = deepseekDelegateInputSchema.safeParse(args)
    expect(
      parsed.success,
      `README example must pass the schema, got: ${JSON.stringify(parsed.error?.issues ?? [])}\n${block}`,
    ).toBe(true)
    presets.add(String((parsed.data as DelegateInput).preset))
  }
  expect(validBlocks.length).toBeGreaterThanOrEqual(7) // per-preset + background + auto-context + vision-write forms
  expect([...presets].sort()).toEqual(["explore", "unrestricted", "vision", "write"])
})

test("the valid unrestricted example carries the exact confirmation token", () => {
  const unrestricted = validBlocks
    .map((block) => parseJson(block, "json delegate") as Record<string, unknown>)
    .filter((args) => args.preset === "unrestricted")
  expect(unrestricted.length).toBe(1)
  expect(unrestricted[0]?.confirm_unrestricted).toBe(UNRESTRICTED_CONFIRMATION_TOKEN)
})

/* ------------------------------------------------------------------ */
/* Documented rejection examples                                       */
/* ------------------------------------------------------------------ */

test("README invalid examples are rejected by the schema as documented", () => {
  expect(invalidBlocks.length).toBeGreaterThanOrEqual(2)
  const rejections = invalidBlocks.map((block) => {
    const args = parseJson(block, "json delegate-invalid")
    const parsed = deepseekDelegateInputSchema.safeParse(args)
    expect(
      !parsed.success,
      `invalid example must NOT pass the schema:\n${block}`,
    ).toBe(true)
    const issues = (parsed.error?.issues ?? []).map((issue) => `${String(issue.path.join("."))}: ${issue.message}`)
    return { preset: (args as Record<string, unknown>).preset as string, issues }
  })
  const unrestricted = rejections.find((r) => r.preset === "unrestricted")
  expect(unrestricted, "README must document the unrestricted-without-token rejection").toBeDefined()
  expect(
    unrestricted?.issues.some((line) => line.includes("confirm_unrestricted") && line.includes(UNRESTRICTED_CONFIRMATION_TOKEN)),
    "the documented rejection message must name the exact token requirement",
  ).toBe(true)
  const write = rejections.find((r) => r.preset === "write")
  expect(write, "README must document the vague-write rejection").toBeDefined()
  expect(write?.issues.some((line) => line.includes("context_packet") && line.includes("allow_auto_context"))).toBe(true)
})

/* ------------------------------------------------------------------ */
/* Output envelopes + plain JSON blocks                                */
/* ------------------------------------------------------------------ */

test("README output-envelope examples pass the DelegateOutput schema", () => {
  expect(outputBlocks.length).toBeGreaterThanOrEqual(2) // completed + error shapes
  for (const block of outputBlocks) {
    const parsed = deepseekDelegateOutputSchema.safeParse(parseJson(block, "json output"))
    expect(parsed.success, `output example must pass the schema: ${JSON.stringify(parsed.error?.issues ?? [])}\n${block}`).toBe(true)
  }
})

test("plain JSON blocks parse and their job ids match the real bg_ pattern", () => {
  expect(plainBlocks.length).toBeGreaterThanOrEqual(2) // companion args + running snapshot
  for (const block of plainBlocks) {
    const value = parseJson(block, "json") as Record<string, unknown>
    const text = JSON.stringify(value)
    for (const id of text.match(/bg_[A-Za-z0-9]+/g) ?? []) {
      expect(id, `job id "${id}" violates the bg_ id contract`).toMatch(/^bg_[a-zA-Z0-9]{8,64}$/)
    }
  }
})

/* ------------------------------------------------------------------ */
/* Content guards (plan todo 12 failure QA)                            */
/* ------------------------------------------------------------------ */

/** Blockquote markers stripped + whitespace collapsed, so guards can span wraps. */
function normalize(markdown: string): string {
  return markdown.replace(/^>\s?/gm, "").replace(/\s+/g, " ")
}
const README_FLAT = normalize(README)

test("README states the v1 network limitation prominently", () => {
  expect(README_FLAT).toContain("does NOT hard-block network access")
  expect(README_FLAT).toContain("Do not delegate tasks over sensitive networks expecting egress isolation")
  // The caveat must appear near the top, before the presets section.
  const caveatIndex = README_FLAT.indexOf("does NOT hard-block network access")
  const presetsIndex = README_FLAT.indexOf("## The four presets")
  expect(caveatIndex).toBeGreaterThan(-1)
  expect(presetsIndex).toBeGreaterThan(-1)
  expect(caveatIndex).toBeLessThan(presetsIndex)
})

test("README names the exact unrestricted token, audit/jobs paths, and smoke contract", () => {
  expect(README_FLAT).toContain("I_UNDERSTAND_DSH_DANGER_FULL_ACCESS")
  expect(README_FLAT).toContain(".omo/deepseek-delegate/jobs/")
  expect(README_FLAT).toContain(".omo/deepseek-delegate/audit/")
  expect(README_FLAT).toContain("RUN_DSH_SMOKE=1")
  expect(README_FLAT).toContain("DEEPSEEK_API_KEY")
  expect(README_FLAT).toContain("docs/v2-network-hardening.md")
})
