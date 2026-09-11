/**
 * Schema + preset capability matrix tests for deepseek_delegate (plan todo 2).
 * Credential-free: pure parse validation, no DSH runtime involved.
 */
import { describe, expect, test } from "bun:test"
import {
  DELEGATE_MODELS,
  UNRESTRICTED_CONFIRMATION_TOKEN,
  VISION_PRESET_DEPRECATED_MESSAGE,
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

describe("happy paths — one canonical valid request per callable preset", () => {
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
  test("explore -> deepseek-flash / read-only", () => {
    expect(resolvePresetDefaults("explore")).toEqual({ model: "deepseek-flash", permission_mode: "read-only" })
  })

  test("write -> deepseek-flash / workspace-write", () => {
    expect(resolvePresetDefaults("write")).toEqual({ model: "deepseek-flash", permission_mode: "workspace-write" })
  })

  test("vision is disabled: defaults stay schema-valid (flash/read-only) and never the removed vision-exp route", () => {
    expect(resolvePresetDefaults("vision")).toEqual({
      model: "deepseek-flash",
      permission_mode: "read-only",
    })
    // A forged override still cannot reach the removed image route.
    expect(resolvePresetDefaults("vision", "workspace-write").model).toBe("deepseek-flash")
    expect(resolvePresetDefaults("vision", "danger-full-access").model).toBe("deepseek-flash")
  })

  test("unrestricted -> deepseek-flash / danger-full-access", () => {
    expect(resolvePresetDefaults("unrestricted")).toEqual({
      model: "deepseek-flash",
      permission_mode: "danger-full-access",
    })
  })

  test("every callable preset resolves the single deepseek-flash route; DELEGATE_MODELS has length 1", () => {
    expect(DELEGATE_MODELS).toHaveLength(1)
    expect([...DELEGATE_MODELS]).toEqual(["deepseek-flash"])
    for (const preset of ["explore", "write", "unrestricted"] as const) {
      expect(resolvePresetDefaults(preset).model).toBe("deepseek-flash")
    }
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

  test('vision preset is disabled: any call is rejected with the deprecation message', () => {
    const withImages = deepseekDelegateInputSchema.safeParse({ preset: "vision", ...base, images: ["/tmp/x.png"] })
    expect(withImages.success).toBe(false)
    const msgs = rejectionMessages(withImages).join("\n")
    expect(msgs).toContain("preset")
    expect(msgs).toContain(VISION_PRESET_DEPRECATED_MESSAGE)
    expect(msgs).toContain("deepseek-flash")
    expect(msgs).toContain("use explore")
    expect(msgs).toContain("write for implementation")
    // "Any vision call" includes the legacy no-images and empty-images forms.
    const noImages = deepseekDelegateInputSchema.safeParse({ preset: "vision", ...base })
    expect(noImages.success).toBe(false)
    expect(rejectionMessages(noImages).join("\n")).toContain(VISION_PRESET_DEPRECATED_MESSAGE)
    const emptyImages = deepseekDelegateInputSchema.safeParse({ preset: "vision", ...base, images: [] })
    expect(emptyImages.success).toBe(false)
    expect(rejectionMessages(emptyImages).join("\n")).toContain(VISION_PRESET_DEPRECATED_MESSAGE)
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
      model: "deepseek-flash",
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
      model: "deepseek-flash",
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
      model: "deepseek-flash",
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
      model: "deepseek-flash",
      permission_mode: "workspace-write",
    })
    expect(r.success).toBe(false)
  })
})
