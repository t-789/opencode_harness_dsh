/**
 * Write-mode context packet builder + guardrail tests (plan todo 6).
 *
 * Covers: full-packet rendering (every present section, canonical order,
 * stop condition + permission statement), the thin-packet fallback rescue
 * under `## Additional context`, guardrail rejections/acceptances, the
 * `buildWritePrompt` seam (packet / auto-context / WRITE_CONTEXT_REQUIRED),
 * and the character budget (truncation of repo_summary/handoff_notes with an
 * "[truncated]" marker; CONTEXT_TOO_LARGE when even truncation cannot fit).
 *
 * Credential-free, fs-free, dependency-free: pure string shaping over
 * schema-typed ContextPacket objects.
 */
import { describe, expect, test } from "bun:test"
import {
  CONTEXT_BUDGET_CHARS,
  ContextError,
  buildWritePrompt,
  renderContextPacket,
  validateWriteContext,
} from "../src/context"
import type { ContextPacket } from "../src/schema"

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

/** Every optional field present — the canonical rich write contract. */
const fullPacket: ContextPacket = {
  objective: "Add a verify command to the harness",
  repo_summary: "Small opencode custom-tool repo with schema and preset modules.",
  relevant_paths: ["src/schema.ts", "tests/schema.test.ts", "dsh/cordis/base.cordis.yml"],
  constraints: "Keep zod at 4.x. No new npm deps.",
  expected_changes: "Add src/context.ts; wire it into tests; no other files touched.",
  verification_commands: ["bun test tests/context.test.ts", "bunx tsc --noEmit -p tsconfig.json"],
  non_goals: "No DSH source edits; no background job plumbing.",
  prior_errors: "First attempt truncated a code fence mid-command.",
  known_failures: "zod 4.1.8 needs z.strictObject for unknown-key rejection.",
  user_instructions: "Report changed files in the final summary.",
  handoff_notes: "Run the verify command before returning.",
}

/** Thin packet: objective only (a valid packet once allow_auto_context is set). */
const thinPacket: ContextPacket = { objective: "Bump the version constant in the CLI." }

/** Canonical heading order — every optional section in its fixed slot. */
const SECTION_HEADINGS = [
  "## Objective",
  "## Repository summary",
  "## Relevant paths",
  "## Constraints",
  "## Expected changes",
  "## Verification commands",
  "## Non-goals",
  "## Prior errors",
  "## Known failures",
  "## User instructions",
  "## Handoff notes",
] as const

function captureContextError(fn: () => unknown): ContextError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ContextError) return error
    throw error
  }
  throw new Error("expected a ContextError but the call succeeded")
}

/* ------------------------------------------------------------------ */
/* Happy: full-packet rendering                                         */
/* ------------------------------------------------------------------ */

describe("renderContextPacket: full packet", () => {
  const rendered = renderContextPacket(fullPacket)

  test("renders the contract header and the objective", () => {
    expect(rendered).toContain("# Write-mode delegation task contract")
    expect(rendered).toContain("## Objective")
    expect(rendered).toContain("Add a verify command to the harness")
  })

  test("renders every present optional section in canonical order", () => {
    let previous = -1
    for (const heading of SECTION_HEADINGS) {
      const index = rendered.indexOf(heading)
      expect(index).toBeGreaterThan(previous)
      previous = index
    }
    // Fixed closing sections come after the last optional one.
    expect(rendered.indexOf("## Stop condition")).toBeGreaterThan(previous)
    expect(rendered.indexOf("## Permissions")).toBeGreaterThan(
      rendered.indexOf("## Stop condition"),
    )
  })

  test("lists each relevant path as a bullet", () => {
    for (const path of fullPacket.relevant_paths!) {
      expect(rendered).toContain(`- ${path}`)
    }
  })

  test("renders verification commands inside a fenced code block", () => {
    expect(rendered).toContain("```\nbun test tests/context.test.ts\nbunx tsc --noEmit -p tsconfig.json\n```")
  })

  test("contains the stop-condition line (stop, report changed files + evidence)", () => {
    expect(rendered).toContain("## Stop condition")
    expect(rendered).toContain("Stop after completing the objective above")
    expect(rendered).toContain("files you changed")
    expect(rendered).toContain("verification evidence")
  })

  test("contains the workspace-write permission statement", () => {
    expect(rendered).toContain("## Permissions")
    expect(rendered).toContain("workspace-write")
    expect(rendered).toContain("confined to the workspace")
    expect(rendered).toContain("auto-rejected")
  })

  test("a rich packet ignores the fallback prompt (no Additional context section)", () => {
    const withFallback = renderContextPacket(fullPacket, "Some raw prompt that must not leak in")
    expect(withFallback).not.toContain("## Additional context")
    expect(withFallback).not.toContain("Some raw prompt that must not leak in")
  })
})

describe("renderContextPacket: thin packet + fallback rescue", () => {
  const fallback = "Bump the version constant in src/cli.ts and update the changelog."

  test("renders the packet and appends the fallback under Additional context", () => {
    const rendered = renderContextPacket(thinPacket, fallback)
    expect(rendered).toContain("## Objective")
    expect(rendered).toContain(thinPacket.objective!)
    expect(rendered).toContain("## Additional context")
    expect(rendered.indexOf("## Additional context")).toBeGreaterThan(
      rendered.indexOf("## Permissions"),
    )
    expect(rendered).toContain(fallback)
  })

  test("drops the fallback when it is identical to the objective", () => {
    const rendered = renderContextPacket(thinPacket, thinPacket.objective)
    expect(rendered).not.toContain("## Additional context")
  })

  test("renders a thin packet without any fallback prompt too", () => {
    const rendered = renderContextPacket(thinPacket)
    expect(rendered).not.toContain("## Additional context")
    expect(rendered).toContain("## Objective")
  })
})

describe("renderContextPacket: verification warning line", () => {
  test("a packet without verification commands surfaces the warning in the rendered output", () => {
    const noVerify: ContextPacket = {
      objective: "Refactor the loader.",
      relevant_paths: ["src/loader.ts"],
    }
    const rendered = renderContextPacket(noVerify)
    expect(rendered).toContain("## Verification commands")
    expect(rendered).toContain("no verification commands supplied — verify manually.")
  })

  test("a packet WITH verification commands never shows the warning line", () => {
    expect(renderContextPacket(fullPacket)).not.toContain("no verification commands supplied")
  })
})

/* ------------------------------------------------------------------ */
/* Guardrails: validateWriteContext                                     */
/* ------------------------------------------------------------------ */

describe("validateWriteContext: rejections", () => {
  test("rejects a missing packet and a missing objective", () => {
    const result = validateWriteContext({} as ContextPacket, { allow_auto_context: false })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("non-empty objective")
  })

  test("rejects a blank objective (empty and whitespace-only)", () => {
    for (const objective of ["", "   ", "\n\t"]) {
      const result = validateWriteContext(
        { objective } as ContextPacket,
        { allow_auto_context: false },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("non-empty objective")
    }
  })

  test("rejects empty/absent relevant_paths without allow_auto_context", () => {
    const noPaths: ContextPacket = { objective: "Do the thing." }
    const cases: ContextPacket[] = [noPaths, { ...noPaths, relevant_paths: [] }, { ...noPaths, relevant_paths: ["   "] }]
    for (const packet of cases) {
      const result = validateWriteContext(packet, { allow_auto_context: false })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe("write mode needs either relevant paths or explicit allow_auto_context")
      }
    }
  })

  test("missing verification commands is acceptable (documented soft rule, no schema field)", () => {
    const result = validateWriteContext(
      { objective: "Refactor the loader.", relevant_paths: ["src/loader.ts"] },
      { allow_auto_context: false },
    )
    expect(result).toEqual({ ok: true })
  })
})

describe("validateWriteContext: acceptances", () => {
  test("accepts a full packet", () => {
    expect(validateWriteContext(fullPacket, { allow_auto_context: false })).toEqual({ ok: true })
  })

  test("accepts an objective-only packet when allow_auto_context is true", () => {
    expect(validateWriteContext(thinPacket, { allow_auto_context: true })).toEqual({ ok: true })
  })

  test("accepts relevant_paths even when allow_auto_context is false", () => {
    expect(
      validateWriteContext(
        { objective: "Refactor the loader.", relevant_paths: ["src/loader.ts"] },
        { allow_auto_context: false },
      ),
    ).toEqual({ ok: true })
  })
})

/* ------------------------------------------------------------------ */
/* buildWritePrompt seam                                                */
/* ------------------------------------------------------------------ */

describe("buildWritePrompt: packet present", () => {
  test("returns the rendered packet with usedPacket true and no warnings", () => {
    const fallback = "Original one-line prompt from the caller."
    const built = buildWritePrompt({
      packet: fullPacket,
      rawPrompt: fallback,
      allow_auto_context: false,
    })
    expect(built.usedPacket).toBe(true)
    expect(built.warnings).toEqual([])
    expect(built.prompt).toBe(renderContextPacket(fullPacket, fallback))
    expect(built.prompt).toContain(fullPacket.objective!)
  })

  test("a thin packet with allow_auto_context is rendered with the raw prompt as fallback context", () => {
    const built = buildWritePrompt({
      packet: thinPacket,
      rawPrompt: "Bump the version constant in src/cli.ts and update the changelog.",
      allow_auto_context: true,
    })
    expect(built.usedPacket).toBe(true)
    expect(built.prompt).toContain("## Additional context")
  })

  test("an invalid supplied packet is rejected with WRITE_CONTEXT_INVALID (layered guard)", () => {
    const error = captureContextError(() =>
      buildWritePrompt({ packet: { objective: "   " } as ContextPacket, rawPrompt: "x", allow_auto_context: false }),
    )
    expect(error.code).toBe("WRITE_CONTEXT_INVALID")
  })
})

describe("buildWritePrompt: packet absent", () => {
  test("allow_auto_context: bounded auto-context wrapper around the raw prompt", () => {
    const raw = "Add a --dry-run flag to the CLI."
    const built = buildWritePrompt({ packet: undefined, rawPrompt: raw, allow_auto_context: true })
    expect(built.usedPacket).toBe(false)
    expect(built.warnings).toEqual(["auto_context"])
    expect(built.prompt).toContain(raw)
    expect(built.prompt).toContain("Map the relevant areas of the workspace first")
    expect(built.prompt).toContain("Do not survey the whole repository")
  })

  test("no packet + no allow_auto_context throws ContextError WRITE_CONTEXT_REQUIRED", () => {
    const error = captureContextError(() =>
      buildWritePrompt({ packet: undefined, rawPrompt: "vague", allow_auto_context: false }),
    )
    expect(error.code).toBe("WRITE_CONTEXT_REQUIRED")
    expect(error.message).toContain("workspace-write")
  })
})

/* ------------------------------------------------------------------ */
/* Character budget                                                     */
/* ------------------------------------------------------------------ */

describe("renderContextPacket: character budget", () => {
  test("oversized repo_summary is truncated with a marker while the objective survives intact", () => {
    const huge = "r".repeat(30_000)
    const packet: ContextPacket = {
      objective: "Keep me visible.",
      relevant_paths: ["src/context.ts"],
      repo_summary: huge,
    }
    const rendered = renderContextPacket(packet)
    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS)
    expect(rendered).toContain("[truncated]")
    expect(rendered).toContain("Keep me visible.")
    expect(rendered).toContain("## Repository summary")
    expect(rendered).not.toContain(huge)
  })

  test("oversized repo_summary AND handoff_notes both get truncated under budget", () => {
    const packet: ContextPacket = {
      objective: "Keep me visible.",
      relevant_paths: ["src/context.ts"],
      repo_summary: "r".repeat(30_000),
      handoff_notes: "h".repeat(20_000),
    }
    const rendered = renderContextPacket(packet)
    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS)
    expect(rendered).toContain("[truncated]")
    expect(rendered).toContain("Keep me visible.")
    expect(rendered).toContain("## Handoff notes")
  })

  test("extreme over-budget with no truncatable fields rejects with CONTEXT_TOO_LARGE", () => {
    // An objective alone over budget cannot be silently truncated → reject.
    const packet: ContextPacket = { objective: "x".repeat(30_000) }
    const error = captureContextError(() => renderContextPacket(packet))
    expect(error.code).toBe("CONTEXT_TOO_LARGE")
  })

  test("constraints are never silently truncated: still over budget → CONTEXT_TOO_LARGE", () => {
    const packet: ContextPacket = {
      objective: "Keep me visible.",
      relevant_paths: ["src/context.ts"],
      repo_summary: "r".repeat(20_000),
      constraints: "c".repeat(20_000), // not truncatable → rejection, not silent loss
    }
    const error = captureContextError(() => renderContextPacket(packet))
    expect(error.code).toBe("CONTEXT_TOO_LARGE")
  })

  test("a large render just under the budget boundary passes with the objective intact", () => {
    // Fixed scaffolding (header, stop condition, permissions, headings, the
    // verification warning slot) consumes a constant overhead; size the
    const overhead = renderContextPacket({ objective: "", relevant_paths: ["src/a.ts"] } as ContextPacket).length
    const objective = "o".repeat(CONTEXT_BUDGET_CHARS - overhead - 1)
    const packet: ContextPacket = { objective, relevant_paths: ["src/a.ts"] }
    const rendered = renderContextPacket(packet)
    expect(rendered.length).toBe(CONTEXT_BUDGET_CHARS - 1)
    expect(rendered.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS)
    expect(rendered).toContain(objective)
  })
})
