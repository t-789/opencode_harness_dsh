/**
 * Schema + preset capability matrix tests for deepseek_delegate (plan todo 2).
 * Credential-free: pure parse validation, no DSH runtime involved.
 */
import { describe, expect, test } from "bun:test"
import {
  UNRESTRICTED_CONFIRMATION_TOKEN,
  deepseekDelegateInputSchema,
  deepseekDelegateOutputSchema,
  delegateJobSchema,
  resolvePresetDefaults,
} from "../src/schema"

const base = { prompt: "Do the delegated task", cwd: "/Users/liuzy/opencode_harness_dsh" }

const writePacket = {
  objective: "Add a verify command to the harness",
  repo_summary: "Small opencode custom-tool repo.",
  relevant_paths: ["src/schema.ts", "tests/schema.test.ts"],
  constraints: "Keep zod at 4.x. No new npm deps.",
  expected_changes: "src/schema.ts and tests/schema.test.ts updated; no other files touched.",
  verification_commands: ["bun test tests/schema.test.ts"],
  non_goals: "No DSH source edits.",
}

function rejectionMessages(r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): string[] {
  return (r.error?.issues ?? []).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
}

describe("happy paths — one canonical valid request per preset", () => {
  test("explore: plain request parses; no context/images/permission needed", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "explore", ...base })
    expect(r.success).toBe(true)
  })

  test("write: with context_packet parses", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "write", ...base, context_packet: writePacket })
    expect(r.success).toBe(true)
  })

  test("write: without context_packet but allow_auto_context: true parses", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "write", ...base, allow_auto_context: true })
    expect(r.success).toBe(true)
  })

  test("vision: with images parses (default read-only)", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "vision", ...base, images: ["/tmp/mock.png"] })
    expect(r.success).toBe(true)
  })

  test("vision: workspace-write override parses", () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: "vision",
      ...base,
      images: ["/tmp/mock.png"],
      permission_mode: "workspace-write",
    })
    expect(r.success).toBe(true)
  })

  test("unrestricted: with exact confirmation token parses", () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: "unrestricted",
      ...base,
      confirm_unrestricted: UNRESTRICTED_CONFIRMATION_TOKEN,
    })
    expect(r.success).toBe(true)
  })

  test("optional numeric/bool/session fields are accepted on any preset", () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: "explore",
      ...base,
      session_id: "ses_abc",
      run_in_background: true,
      max_tokens: 4096,
      timeout_ms: 120_000,
    })
    expect(r.success).toBe(true)
  })
})

describe("resolvePresetDefaults capability matrix", () => {
  test("explore -> deepseek-v4-flash / read-only", () => {
    expect(resolvePresetDefaults("explore")).toEqual({ model: "deepseek-v4-flash", permission_mode: "read-only" })
  })

  test("write -> deepseek-v4-flash / workspace-write", () => {
    expect(resolvePresetDefaults("write")).toEqual({ model: "deepseek-v4-flash", permission_mode: "workspace-write" })
  })

  test("vision -> deepseek-v4-flash-vision-exp / read-only by default, workspace-write on explicit override", () => {
    expect(resolvePresetDefaults("vision")).toEqual({
      model: "deepseek-v4-flash-vision-exp",
      permission_mode: "read-only",
    })
    expect(resolvePresetDefaults("vision", "read-only")).toEqual({
      model: "deepseek-v4-flash-vision-exp",
      permission_mode: "read-only",
    })
    expect(resolvePresetDefaults("vision", "workspace-write")).toEqual({
      model: "deepseek-v4-flash-vision-exp",
      permission_mode: "workspace-write",
    })
  })

  test("unrestricted -> deepseek-v4-flash / danger-full-access", () => {
    expect(resolvePresetDefaults("unrestricted")).toEqual({
      model: "deepseek-v4-flash",
      permission_mode: "danger-full-access",
    })
  })
})

describe("failure paths — schema-level matrix enforcement", () => {
  test("arbitrary model field is rejected (unknown key)", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "explore", ...base, model: "gpt-4" })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("model")
  })

  test("arbitrary provider field is rejected (unknown key)", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "explore", ...base, provider: "anthropic" })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("provider")
  })

  test("unrestricted without confirmation token is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "unrestricted", ...base })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("confirm_unrestricted")
    expect(msgs.join("\n")).toContain(UNRESTRICTED_CONFIRMATION_TOKEN)
  })

  test("unrestricted with a wrong confirmation token is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "unrestricted", ...base, confirm_unrestricted: "maybe?" })
    expect(r.success).toBe(false)
  })

  test("vision without images is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "vision", ...base })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("images")
  })

  test("vision with an empty images array is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "vision", ...base, images: [] })
    expect(r.success).toBe(false)
  })

  test("write without context_packet and without allow_auto_context is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "write", ...base })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("context_packet")
  })

  test("explore with images is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "explore", ...base, images: ["/tmp/x.png"] })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("images")
  })

  test("explore with permission_mode workspace-write is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "explore", ...base, permission_mode: "workspace-write" })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("permission_mode")
  })

  test("write with permission_mode read-only is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: "write",
      ...base,
      context_packet: writePacket,
      permission_mode: "read-only",
    })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("permission_mode")
  })

  test("vision with permission_mode danger-full-access is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: "vision",
      ...base,
      images: ["/tmp/x.png"],
      permission_mode: "danger-full-access",
    })
    expect(r.success).toBe(false)
    const msgs = rejectionMessages(r)
    expect(msgs.join("\n")).toContain("permission_mode")
  })

  test("unrestricted with caller-supplied permission_mode is rejected (resolves internally)", () => {
    const r = deepseekDelegateInputSchema.safeParse({
      preset: "unrestricted",
      ...base,
      permission_mode: "read-only",
      confirm_unrestricted: UNRESTRICTED_CONFIRMATION_TOKEN,
    })
    expect(r.success).toBe(false)
  })

  test("empty prompt is rejected", () => {
    const r = deepseekDelegateInputSchema.safeParse({ preset: "explore", prompt: "", cwd: base.cwd })
    expect(r.success).toBe(false)
  })
})

describe("output and job schemas", () => {
  test("canonical completed output parses", () => {
    const r = deepseekDelegateOutputSchema.safeParse({
      status: "completed",
      preset: "explore",
      session_id: "ses_1",
      model: "deepseek-v4-flash",
      permission_mode: "read-only",
      final_response: "summary",
      finish_reason: "complete",
      audit_path: "/tmp/audit.json",
    })
    expect(r.success).toBe(true)
  })

  test("error output parses with structured error", () => {
    const r = deepseekDelegateOutputSchema.safeParse({
      status: "error",
      preset: "unrestricted",
      model: "deepseek-v4-flash",
      permission_mode: "danger-full-access",
      error: { code: "PREFLIGHT_REJECTED", message: "no token" },
    })
    expect(r.success).toBe(true)
  })

  test("persisted background job with ISO created_at parses", () => {
    const r = delegateJobSchema.safeParse({
      job_id: "bg_123",
      preset: "write",
      created_at: new Date().toISOString(),
      cwd: base.cwd,
      session_id: "ses_1",
      status: "running",
      model: "deepseek-v4-flash",
      permission_mode: "workspace-write",
      pid: 4242,
    })
    expect(r.success).toBe(true)
  })

  test("persisted job rejects a non-ISO created_at", () => {
    const r = delegateJobSchema.safeParse({
      job_id: "bg_123",
      preset: "write",
      created_at: "not-a-date",
      cwd: base.cwd,
      status: "running",
      model: "deepseek-v4-flash",
      permission_mode: "workspace-write",
    })
    expect(r.success).toBe(false)
  })
})
