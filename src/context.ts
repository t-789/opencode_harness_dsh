/**
 * Write-mode context packet builder and guardrails (plan todo 6).
 *
 * `deepseek_delegate` preset "write" runs under DSH `workspace-write`. Before
 * anything is delegated, the caller's `context_packet` — or an explicitly
 * permitted auto-context run — must become a BOUNDED, explicit task contract:
 * the delegated agent implements what the contract says instead of
 * rediscovering the repository from zero (the core motivation for write
 * context packets).
 *
 * This module owns three seams that the tool execute path (todo 7) imports:
 *   - `renderContextPacket(packet, fallbackPrompt?)` — packet → the exact
 *     prompt text sent to DSH (markdown, character-bounded).
 *   - `validateWriteContext(packet, { allow_auto_context })` — guardrail gate
 *     returning `{ ok: true }` or `{ ok: false, reason }`.
 *   - `buildWritePrompt({ packet?, rawPrompt, allow_auto_context })` — the
 *     high-level seam preset-map's `rendered_prompt` slot expects: decides
 *     packet-vs-auto-context, validates, renders, and returns metadata.
 *
 * Design decisions (each deliberate; mirrored in learnings.md):
 *
 *  1. Verification commands are SOFT (documented decision). The schema has NO
 *     `verification_unavailable_reason` field and only requires `objective`,
 *     so a packet without verification commands is ADMISSIBLE — but the
 *     absence must be surfaced. `## Verification commands` is therefore the
 *     one section that is always rendered: a fenced code block when commands
 *     exist, else the literal warning line
 *     "no verification commands supplied — verify manually." Rendering the
 *     heading with the warning is clearer for the delegated agent than a
 *     stray warning line elsewhere, and it is how the "must be surfaced in
 *     the rendered packet" rule is honored. Every OTHER optional section
 *     renders only when present.
 *
 *  2. Character budget. Rendered output is capped at CONTEXT_BUDGET_CHARS
 *     (12 000). Over budget, the renderer truncates `repo_summary` first,
 *     then `handoff_notes` — each keeps its head plus an "[truncated]"
 *     marker; a field reduced to nothing is dropped together with its
 *     section. `objective`, `constraints`, the path/command arrays and every
 *     other field are NEVER truncated silently; if the output is still over
 *     budget the render throws `ContextError` code CONTEXT_TOO_LARGE with an
 *     explicit reason (the caller must shorten the inputs).
 *
 *  3. Thin-packet fallback rescue. When the packet carries ONLY an objective
 *     and a fallback prompt (the caller's raw prompt) is supplied, the
 *     packet is still rendered and the fallback is appended under
 *     `## Additional context` — unless the fallback is empty or identical to
 *     the objective. Rich packets (any optional field present) ignore the
 *     fallback: it adds nothing once the packet carries structure.
 *
 *  4. Layered validation in `buildWritePrompt`. It runs the same guardrails
 *     as `validateWriteContext` before rendering so an empty/vague contract
 *     can never reach a workspace-write run even when a caller skips the
 *     explicit validate step (mirrors the mapping layer's unrestricted-token
 *     re-check; the plan must-not "no empty/vague write task" holds at both
 *     boundaries).
 *
 * No API calls, no credentials, no new dependencies, no filesystem access.
 */
import type { ContextPacket } from "./schema.ts"

/** Rendered-prompt character cap (contracts stay small enough to read). */
export const CONTEXT_BUDGET_CHARS = 12_000

/** Suffix appended to a truncated field so truncation is never silent. */
const TRUNCATION_MARKER = "\n[truncated]"

/** Exact warning line rendered when a packet supplies no verification commands. */
const VERIFY_WARNING_LINE = "no verification commands supplied — verify manually."

/**
 * Typed error for context-layer contract violations. `code` maps straight
 * into the structured delegate output `error.code` (todo 7/10), mirroring
 * `PresetMappingError` in preset-map.ts.
 *
 * Codes:
 *   - `WRITE_CONTEXT_REQUIRED`  — buildWritePrompt: no packet and no
 *     allow_auto_context on the write preset.
 *   - `WRITE_CONTEXT_INVALID`   — a supplied packet fails the guardrails
 *     (blank objective, or no relevant paths without allow_auto_context).
 *   - `CONTEXT_TOO_LARGE`       — render still exceeds the character budget
 *     after truncating repo_summary/handoff_notes.
 */
export class ContextError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "ContextError"
    this.code = code
  }
}

/** Guardrail result: accepted, or rejected with a human-readable reason. */
export type WriteContextValidation = { ok: true } | { ok: false; reason: string }

/** Input for the preset-map `rendered_prompt` seam. */
export interface BuildWritePromptInput {
  /** Schema-validated write context packet (may be absent for auto-context). */
  packet?: ContextPacket
  /** The caller's raw prompt (schema `prompt`); fallback for thin packets. */
  rawPrompt: string
  /** Explicit caller opt-in: permit a packet-less, pre-mapped workspace run. */
  allow_auto_context: boolean
}

/** Output of {@link buildWritePrompt}: the exact prompt + bookkeeping. */
export interface BuiltWritePrompt {
  /** Prompt text to hand DSH (via the mapping `rendered_prompt` seam). */
  prompt: string
  /** True when the prompt was rendered from a context packet. */
  usedPacket: boolean
  /** Non-empty when the caller should be told about a degraded mode. */
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* Small normalization helpers                                         */
/* ------------------------------------------------------------------ */

function textOrEmpty(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function trimmedLines(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return []
  const lines: string[] = []
  for (const entry of value) {
    const line = typeof entry === "string" ? entry.trim() : ""
    if (line !== "") lines.push(line)
  }
  return lines
}

/** True when the packet carries ONLY an objective (every optional field empty). */
function isThinPacket(packet: ContextPacket): boolean {
  return (
    textOrEmpty(packet.repo_summary) === "" &&
    trimmedLines(packet.relevant_paths).length === 0 &&
    textOrEmpty(packet.constraints) === "" &&
    textOrEmpty(packet.expected_changes) === "" &&
    trimmedLines(packet.verification_commands).length === 0 &&
    textOrEmpty(packet.non_goals) === "" &&
    textOrEmpty(packet.prior_errors) === "" &&
    textOrEmpty(packet.known_failures) === "" &&
    textOrEmpty(packet.user_instructions) === "" &&
    textOrEmpty(packet.handoff_notes) === ""
  )
}

/**
 * Truncate a field's content to remove `excess` characters while keeping a
 * visible "[truncated]" marker. The extra `marker + 2` cut guarantees the
 * re-added marker cannot push the total back over budget. Returns "" when
 * nothing usable remains (the caller drops the section then).
 */
function shrinkToFit(text: string, excess: number): string {
  const keep = text.length - excess - TRUNCATION_MARKER.length - 2
  if (keep <= 0) return ""
  return text.slice(0, keep) + TRUNCATION_MARKER
}

/* ------------------------------------------------------------------ */
/* Fixed contract scaffolding                                          */
/* ------------------------------------------------------------------ */

const HEADER = `# Write-mode delegation task contract

You are delegated a workspace-write implementation task. This document is the
task contract: implement exactly what it specifies, then stop (see the stop
condition below). It is deliberately bounded so you do not need to rediscover
the repository from zero.`

const STOP_CONDITION = `Stop after completing the objective above and running the
verification commands (if any were supplied). Do not expand scope or continue
into unrelated improvements. Report the files you changed and the
test/verification evidence you collected (commands run and their pass/fail
output).`

const PERMISSION_STATEMENT = `This run executes under workspace-write: your
writes are confined to the workspace, and any escalation attempt outside it
is auto-rejected (a delegated run has no interactive approval). Implement
within the workspace.`

function mdSection(heading: string, body: string): string {
  return `## ${heading}\n\n${body}`
}

/**
 * Assemble the markdown packet. `repoText`/`handoffText` are the possibly
 * truncated field bodies ("" drops the section); `additional` is the
 * thin-packet fallback body when one applies (rendered last).
 */
function assemble(
  packet: ContextPacket,
  repoText: string,
  handoffText: string,
  additional: string | undefined,
): string {
  const blocks: string[] = [HEADER]
  const objective = textOrEmpty(packet.objective)
  const relevant = trimmedLines(packet.relevant_paths)
  const constraints = textOrEmpty(packet.constraints)
  const expected = textOrEmpty(packet.expected_changes)
  const commands = trimmedLines(packet.verification_commands)
  const nonGoals = textOrEmpty(packet.non_goals)
  const priorErrors = textOrEmpty(packet.prior_errors)
  const knownFailures = textOrEmpty(packet.known_failures)
  const userInstructions = textOrEmpty(packet.user_instructions)

  blocks.push(mdSection("Objective", objective))
  if (repoText !== "") blocks.push(mdSection("Repository summary", repoText))
  if (relevant.length > 0) {
    blocks.push(mdSection("Relevant paths", relevant.map((path) => `- ${path}`).join("\n")))
  }
  if (constraints !== "") blocks.push(mdSection("Constraints", constraints))
  if (expected !== "") blocks.push(mdSection("Expected changes", expected))

  // Verification is the one always-present optional section: when no commands
  // were supplied the section body IS the surfaced warning (decision 1).
  const verificationBody =
    commands.length > 0 ? "```\n" + commands.join("\n") + "\n```" : VERIFY_WARNING_LINE
  blocks.push(mdSection("Verification commands", verificationBody))

  if (nonGoals !== "") blocks.push(mdSection("Non-goals", nonGoals))
  if (priorErrors !== "") blocks.push(mdSection("Prior errors", priorErrors))
  if (knownFailures !== "") blocks.push(mdSection("Known failures", knownFailures))
  if (userInstructions !== "") blocks.push(mdSection("User instructions", userInstructions))
  if (handoffText !== "") blocks.push(mdSection("Handoff notes", handoffText))

  blocks.push(mdSection("Stop condition", STOP_CONDITION))
  blocks.push(mdSection("Permissions", PERMISSION_STATEMENT))

  if (additional !== undefined) {
    blocks.push(mdSection("Additional context", additional))
  }

  return blocks.join("\n")
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Guardrails for a write context packet. Returns `{ ok: true }` or
 * `{ ok: false; reason }` — never throws.
 *
 * Rules:
 *   - objective must be present and non-blank                        → else reject.
 *   - relevant_paths must be non-empty UNLESS `allow_auto_context`    → else reject
 *     is true (reason: "write mode needs either relevant paths or
 *     explicit allow_auto_context").
 *   - verification_commands may be absent (documented decision: the schema
 *     has no `verification_unavailable_reason` field; absence is surfaced as
 *     a warning line by `renderContextPacket`, not rejected here).
 */
export function validateWriteContext(
  packet: ContextPacket,
  opts: { allow_auto_context: boolean },
): WriteContextValidation {
  if (packet === null || typeof packet !== "object" || textOrEmpty(packet.objective) === "") {
    return { ok: false, reason: "write mode requires a context packet with a non-empty objective" }
  }
  if (trimmedLines(packet.relevant_paths).length === 0 && opts.allow_auto_context !== true) {
    return {
      ok: false,
      reason: "write mode needs either relevant paths or explicit allow_auto_context",
    }
  }
  return { ok: true }
}

/**
 * Render a write-mode context packet into the exact prompt text sent to DSH.
 *
 * Section order is fixed: header → Objective → Repository summary → Relevant
 * paths → Constraints → Expected changes → Verification commands (always) →
 * Non-goals → Prior errors → Known failures → User instructions → Handoff
 * notes → Stop condition → Permissions → Additional context (thin-packet
 * fallback only). Optional sections render only when present (verification is
 * the documented exception: absent commands render the warning line instead).
 *
 * Character budget: see module docs (decision 2). Throws `ContextError`
 * CONTEXT_TOO_LARGE when the budget cannot be met without silently truncating
 * non-negotiable fields.
 */
export function renderContextPacket(packet: ContextPacket, fallbackPrompt?: string): string {
  if (packet === null || typeof packet !== "object") {
    throw new ContextError("WRITE_CONTEXT_INVALID", "write context requires a context packet object")
  }

  const objective = textOrEmpty(packet.objective)
  const fallback = fallbackPrompt === undefined ? "" : fallbackPrompt.trim()
  const additional =
    fallback !== "" && fallback !== objective && isThinPacket(packet) ? fallback : undefined

  // Truncatable fields only; everything else in the packet is fixed content.
  let repoText = textOrEmpty(packet.repo_summary)
  let handoffText = textOrEmpty(packet.handoff_notes)

  let out = assemble(packet, repoText, handoffText, additional)
  // Each shrink removes `excess` + marker + 2 chars of content, so a couple of
  // rounds always lands under budget; the round cap only fires on pathological
  // input and falls through to the CONTEXT_TOO_LARGE rejection below.
  for (let round = 0; round < 4 && out.length > CONTEXT_BUDGET_CHARS; round++) {
    const excess = out.length - CONTEXT_BUDGET_CHARS
    if (repoText !== "") repoText = shrinkToFit(repoText, excess)
    else if (handoffText !== "") handoffText = shrinkToFit(handoffText, excess)
    else break
    out = assemble(packet, repoText, handoffText, additional)
  }
  if (out.length > CONTEXT_BUDGET_CHARS) {
    throw new ContextError(
      "CONTEXT_TOO_LARGE",
      `rendered write context packet is ${out.length} chars, over the ${CONTEXT_BUDGET_CHARS}-char budget even after truncating repo_summary and handoff_notes; objective, constraints and other fields are never truncated silently — shorten the packet inputs`,
    )
  }
  return out
}

/** Bounded auto-context wrapper for packet-less write runs (decision in module docs). */
function autoContextPrompt(rawPrompt: string): string {
  const task = typeof rawPrompt === "string" ? rawPrompt.trim() : ""
  return `# Delegated write task (auto-context)

The caller allowed auto-context, so no context packet was supplied and the
workspace was not pre-mapped for you.

Map the relevant areas of the workspace first: locate the files and modules
this task touches and confirm the existing conventions, then implement.
Keep the exploration pass bounded — read only what the task requires and
stop exploring once you have enough context to make the changes.
Do not survey the whole repository.

## Task

${task === "" ? "(no task text supplied)" : task}

## Working agreement

This run executes under workspace-write: writes are confined to the workspace
and escalation outside it is auto-rejected. Stop after completing the task
and running the applicable verification, then report the files you changed
and the test/verification evidence you collected.
`
}

/**
 * The preset-map `rendered_prompt` seam (todo 7 calls this before building
 * the bridge request):
 *
 *   - packet present      → validate (layered) + render with the raw prompt
 *                           as the thin-packet fallback; `usedPacket: true`.
 *   - packet absent + auto→ bounded auto-context wrapper around the raw
 *     context true          prompt; `usedPacket: false`; warnings = ["auto_context"].
 *   - packet absent + auto→ throws `ContextError` WRITE_CONTEXT_REQUIRED
 *     context false         (the schema rejects this input upstream; the throw
 *                           covers callers that bypass safeParse).
 */
export function buildWritePrompt(build: BuildWritePromptInput): BuiltWritePrompt {
  const { packet, rawPrompt, allow_auto_context } = build

  if (packet !== undefined) {
    const gate = validateWriteContext(packet, { allow_auto_context })
    if (!gate.ok) {
      throw new ContextError("WRITE_CONTEXT_INVALID", gate.reason)
    }
    return {
      prompt: renderContextPacket(packet, rawPrompt),
      usedPacket: true,
      warnings: [],
    }
  }

  if (allow_auto_context === true) {
    return {
      prompt: autoContextPrompt(rawPrompt),
      usedPacket: false,
      warnings: ["auto_context"],
    }
  }

  throw new ContextError(
    "WRITE_CONTEXT_REQUIRED",
    'preset "write" requires a context_packet (or allow_auto_context: true); refusing a workspace-write run with no task contract',
  )
}
