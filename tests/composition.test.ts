import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Project-owned DSH Cordis composition gate (todo 4):
// base.cordis.yml serves the SANDBOXED SDK JSON-RPC runtime for text presets
// (explore/write); vision.cordis.yml adds the durable attachment store and
// advertises the image-capable model route. Tests assert on file TEXT plus
// light structural row checks (no heavy YAML dependency by design — `!!js`
// tags are runtime-only).
//
// SECURITY INVARIANT: the compositions must mount the sandboxed shell/filesystem
// stack (dsh-sandbox-local + dsh-sandbox-policy + dsh-bash-sandbox +
// dsh-fs-sandbox + dsh-user-approval), NOT the unconfined dsh-bash-local /
// dsh-fs-local rows (danger-full-access). explore=read-only and
// write=workspace-write must be enforced file permissions.

const dshDir = resolve(import.meta.dir, "..", "dsh", "cordis")
const baseText = readFileSync(resolve(dshDir, "base.cordis.yml"), "utf8")
const visionText = readFileSync(resolve(dshDir, "vision.cordis.yml"), "utf8")

const WEB_TOOL_MARKERS = ["web_search", "web_fetch", "dsh-tool-web", "tool-web"]

// Unconfined executor rows would silently grant danger-full-access file reach.
const UNCONFINED_MARKERS = ["dsh-bash-local", "dsh-fs-local"]

// Required sandboxed-stack plugins for enforced file permissions.
const SANDBOXED_PLUGINS = [
  "@deepseek-ai/dsh-sandbox-local",
  "@deepseek-ai/dsh-sandbox-policy",
  "@deepseek-ai/dsh-bash-sandbox",
  "@deepseek-ai/dsh-fs-sandbox",
  "@deepseek-ai/dsh-user-approval",
]

/** Extract top-level plugin rows: `- id: <id>` followed by a `name:` line. */
function rows(text: string): { id: string; name: string | null }[] {
  const result: { id: string; name: string | null }[] = []
  let current: { id: string; name: string | null } | null = null
  for (const line of text.split("\n")) {
    const idMatch = /^- id:\s*(\S+)\s*$/.exec(line)
    if (idMatch) {
      if (current) result.push(current)
      current = { id: idMatch[1], name: null }
      continue
    }
    const nameMatch = /^ {2}name:\s*'([^']+)'\s*$/.exec(line)
    if (nameMatch && current) current.name = nameMatch[1]
  }
  if (current) result.push(current)
  return result
}

function names(text: string): string[] {
  return rows(text).map((r) => r.name).filter((n): n is string => n !== null)
}

describe("dsh cordis base composition (text presets)", () => {
  test("mounts the SDK JSON-RPC server and DeepSeek adapter", () => {
    const n = names(baseText)
    expect(n).toContain("@deepseek-ai/dsh-sdk-jsonrpc-server")
    expect(n).toContain("@deepseek-ai/dsh-llm-deepseek")
  })

  test("mounts the SANDBOXED stack for enforced file permissions", () => {
    const n = names(baseText)
    for (const p of SANDBOXED_PLUGINS) expect(n).toContain(p)
  })

  test("does NOT mount the unconfined dsh-bash-local / dsh-fs-local rows", () => {
    for (const marker of UNCONFINED_MARKERS) expect(baseText).not.toContain(marker)
  })

  test("exposes no web tool row", () => {
    for (const marker of WEB_TOOL_MARKERS) expect(baseText).not.toContain(marker)
  })

  test("stays lean: no attachment-local", () => {
    expect(baseText).not.toContain("attachment-local")
  })
})

describe("dsh cordis vision composition (vision preset)", () => {
  test("mounts the SDK JSON-RPC server and DeepSeek adapter", () => {
    const n = names(visionText)
    expect(n).toContain("@deepseek-ai/dsh-sdk-jsonrpc-server")
    expect(n).toContain("@deepseek-ai/dsh-llm-deepseek")
  })

  test("mounts the SANDBOXED stack for enforced file permissions", () => {
    const n = names(visionText)
    for (const p of SANDBOXED_PLUGINS) expect(n).toContain(p)
  })

  test("does NOT mount the unconfined dsh-bash-local / dsh-fs-local rows", () => {
    for (const marker of UNCONFINED_MARKERS) expect(visionText).not.toContain(marker)
  })

  test("exposes no web tool row", () => {
    for (const marker of WEB_TOOL_MARKERS) expect(visionText).not.toContain(marker)
  })

  test("mounts the durable attachment store", () => {
    expect(names(visionText)).toContain("@deepseek-ai/dsh-attachment-local")
  })

  test("advertises the image-capable model route", () => {
    expect(visionText).toContain("deepseek-v4-flash-vision-exp")
    // The catalog entry must declare image modality (text-only routes reject images).
    const entry = /- id: deepseek-v4-flash-vision-exp\s*\n\s*inputModalities:\s*\[text, image\]/.exec(visionText)
    expect(entry).not.toBeNull()
  })
})

describe("composition structural sanity", () => {
  test("every plugin row has an id and a resolvable @deepseek-ai name", () => {
    for (const [label, text] of [["base", baseText], ["vision", visionText]] as const) {
      const parsed = rows(text)
      expect(parsed.length).toBeGreaterThan(10)
      for (const r of parsed) {
        expect(r.id.length, `${label}: row id`).toBeGreaterThan(0)
        expect(r.name, `${label}: ${r.id} has name`).not.toBeNull()
        expect(r.name, `${label}: ${r.id} name is scoped`).toMatch(/^@deepseek-ai\//)
      }
    }
  })

  test("keeps every plugin name within the supported SDK runtime closure", () => {
    // Allowed set: the SANDBOXED SDK runtime plugin names (bash-sandbox and
    // fs-sandbox REPLACE the unconfined bash-local/fs-local) plus the
    // attachment store the vision overlay adds. No other plugin may appear.
    const allowed = new Set([
      "@deepseek-ai/dsh-sdk-jsonrpc-server",
      "@deepseek-ai/dsh-llm-deepseek",
      "@deepseek-ai/dsh-sandbox-local",
      "@deepseek-ai/dsh-sandbox-policy",
      "@deepseek-ai/dsh-subprocess-local",
      "@deepseek-ai/dsh-bash-sandbox",
      "@deepseek-ai/dsh-user-approval",
      "@deepseek-ai/dsh-agent-spine-demo",
      "@deepseek-ai/dsh-session-persistence-jsonl",
      "@deepseek-ai/dsh-session-checkpoint-policy",
      "@deepseek-ai/dsh-subagent",
      "@deepseek-ai/dsh-subagent-spawn-in-process",
      "@deepseek-ai/dsh-tool-subagent",
      "@deepseek-ai/dsh-tool-todo",
      "@deepseek-ai/dsh-fs-sandbox",
      "@deepseek-ai/dsh-fs-observation-policy",
      "@deepseek-ai/dsh-tool-fs",
      "@deepseek-ai/dsh-token-meter",
      "@deepseek-ai/dsh-compaction-basic",
      "@deepseek-ai/dsh-attachment-local",
    ])
    for (const [label, text] of [["base", baseText], ["vision", visionText]] as const) {
      for (const n of names(text)) expect(allowed.has(n), `${label}: ${n} in closure`).toBe(true)
    }
  })

  test("approval policy is never (unattended, deterministic escalation rejection)", () => {
    for (const [label, text] of [["base", baseText], ["vision", visionText]] as const) {
      expect(text, `${label}: approval row present`).toContain("@deepseek-ai/dsh-user-approval")
      // policy must be statically never (or env-driven expression defaulting never),
      // never a live 'ask'.
      const policyLine = /^ {4}policy:.*$/m.exec(text)
      expect(policyLine, `${label}: policy config line`).not.toBeNull()
      expect(policyLine![0], `${label}: policy is never`).toContain("never")
      expect(policyLine![0], `${label}: policy is not ask`).not.toContain("'ask'")
    }
  })

  test("sandbox-policy defaults to read-only (fail-safe) with env override", () => {
    for (const [label, text] of [["base", baseText], ["vision", visionText]] as const) {
      const modeLine = /mode:\s*!!js.*DSH_PERMISSION_MODE.*read-only/.exec(text)
      expect(modeLine, `${label}: DSH_PERMISSION_MODE override with read-only default`).not.toBeNull()
    }
  })

  test("contains no absolute host paths (env-relative configs only)", () => {
    for (const [label, text] of [["base", baseText], ["vision", visionText]] as const) {
      expect(text, `${label}: no /Users host path`).not.toContain("/Users/")
      expect(text, `${label}: no /private host path`).not.toContain("/private/")
      expect(text, `${label}: no deepseek-harness checkout path`).not.toContain("deepseek-harness/")
    }
  })

  test("list rows are well-formed (indented name under each - id)", () => {
    for (const [label, text] of [["base", baseText], ["vision", visionText]] as const) {
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (/^- id:/.test(lines[i])) {
          // Next non-comment/blank line is the indented name.
          let j = i + 1
          while (j < lines.length && (lines[j].trim() === "" || lines[j].trim().startsWith("#"))) j++
          expect(lines[j] ?? "", `${label} line ${i + 1}: name under id`).toMatch(/^ {2}name:/)
        }
      }
    }
  })
})
