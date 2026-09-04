# deepseek-delegation-tool Draft

status: awaiting-approval
intent: clear
slug: deepseek-delegation-tool

## User Goal

Plan an opencode integration that delegates selected tasks to DeepSeek Harness instead of directly using DeepSeek-backed subagents. The user wants four primary presets:

1. explore: read-only repository exploration and summary.
2. write: workspace-write task execution with strong context management so DeepSeek does not waste time rediscovering the repository and knows exactly what to do.
3. vision: image-reading tasks using `deepseek-v4-flash-vision-exp`.
4. unrestricted: all-powerful mode with no restrictions, but gated so it is not used casually.

## Components Ledger

| ID | Outcome | Status | Evidence |
|---|---|---|---|
| C1 integration surface | First-class opencode-callable DeepSeek delegation surface with structured results, background jobs, and session continuity. | exploring | `dsh_answer.md`, `python/sdk/src/deepseek_harness/api.py`, ACP docs |
| C2 mode presets | Four narrow presets with fixed model/permission defaults and schema-level gating. | exploring | user request, SDK config, DSH sandbox docs |
| C3 context manager | Context packaging for write tasks: opencode supplies targeted repo summary, paths, constraints, and verification instead of letting DeepSeek re-explore from zero. | open | needs plan design |
| C4 safety controls | File permission, approval fail-closed, network blocking for tools, and explicit gate for unrestricted mode. | exploring | DSH sandbox/approval docs, user network requirement |

## Confirmed Facts

- The repository at `/Users/liuzy/opencode_harness_dsh` is currently a planning/integration shell with `dsh_answer.md`, `plugin.md`, and `.omo`; there is no product implementation yet.
- DeepSeek Harness Python SDK exposes `DeepSeekHarness(provider, model, cwd, session_root, cordis, env, ...)`, keeps a reusable runtime subprocess, and supports `run(..., session_id=...)` with `RunResult(session_id, final_response, finish_reason, events, notifications)`.
- ACP is intended for parent agents and subagent providers, but current ACP has fresh-session-only limitations and does not expose usage/live internals.
- `examples/jsonrpc-agent/cordis.yml` is a supported unattended composition with JSON-RPC server, DeepSeek adapter, local bash, filesystem tools, subagent tool, todo tool, JSONL persistence, and compaction. It has no web_search/web_fetch tool by default.
- DSH `SandboxMode` is file-effect only: `read-only`, `workspace-write`, `danger-full-access`; network is outside the built-in vocabulary.
- DSH approval is fail-closed: approval requests settle as unavailable/rejected when no allowed outcome is provided.
- `@deepseek-ai/dsh-subagent-dsh-sdk` is an existing proof that a DSH runtime can be driven as a subagent-like subprocess over JSON-RPC. It resolves cwd from the parent session cwd, scrubs credential-shaped/`DSH_*` parent environment by default, and layers explicit env values back in.
- The SDK-backed path is better than headless CLI for this project because it already provides structured results, explicit `session_id`, configurable model/provider, and a reusable runtime subprocess.
- ACP is explicitly intended for parent agents and image prompts, but current ACP has fresh-session-only limitations and hides usage/live internals; it is still the best reference for the vision image attachment composition.
- `deepseek-v4-flash-vision-exp` is advertised by the DeepSeek adapter as `inputModalities: [text, image]`. Image input requires an attachment store; absence of `ctx.attachments` rejects image input with `UNSUPPORTED_CONTENT`.
- `examples/acp-agent/image.cordis.yml` demonstrates the required vision overlay: select `deepseek-v4-flash-vision-exp` and mount `@deepseek-ai/dsh-attachment-local`.
- `dsh-sandbox-local` on macOS uses Seatbelt for file writes only; `bash-sandbox` documentation explicitly states network remains unrestricted. Hard subprocess egress blocking requires a custom sandbox/subprocess backend or equivalent OS/container boundary.
- opencode/Oh My OpenAgent supports runtime-injected MCPs and `.mcp.json` loading. A local MCP server is a viable fallback, but the lower-risk first implementation surface is a project-scoped custom tool with Zod schema; MCP is the upgrade/fallback path if opencode-native session/background hooks are needed later.
- User-level opencode config currently contains provider credentials inline; the delegation tool must scrub inherited environment and pass only the explicit DeepSeek credential/base URL needed by the DSH runtime.
- opencode 1.18.27 also supports a lower-risk **Custom Tool** surface (`.opencode/tools/*.ts` or `~/.config/opencode/tools/*.ts`) with a filename-driven tool id and Zod schema. That is the lowest-risk first implementation surface for `deepseek_delegate`; a plugin file is the upgrade path only if opencode-native background session hooks are required.

## Open Owner Decisions

- Resolved: v1 does not require hard subprocess network blocking yet.
- Resolved: unrestricted mode requires per-invocation confirmation.
- Resolved: vision mode may optionally allow workspace-write.
- Resolved: first implementation target is a project-scoped custom tool.

## Tentative Topology

| Preset | Model | Permission | Images | Network posture | Intended output |
|---|---|---|---|---|---|
| explore | `deepseek-v4-flash` | `read-only` | no | no web tools; subprocess network hard block in v2 | repository summary with cited paths |
| write | `deepseek-v4-flash` | `workspace-write` | no by default | no web tools; subprocess network hard block in v2 | patch/work summary, changed files, test evidence |
| vision | `deepseek-v4-flash-vision-exp` | default read-only | yes | no web tools; image attachment store enabled | image analysis and optional cited code findings |
| unrestricted | configurable default `deepseek-v4-flash` | `danger-full-access` | optional | unrestricted unless separately configured | emergency task result with audit trail |

## Planning Notes

- Write mode needs a context packet assembled by the opencode-side wrapper before invoking DSH: task objective, current cwd, relevant user instructions, known files/paths, recent errors/logs, expected verification command(s), explicit non-goals, and a stop condition. The wrapper should prefer opencode-side exploration before DSH write mode so DeepSeek spends tokens implementing rather than rediscovering basics.
- Explore mode should return a bounded structured report and should not preserve long-lived shell/session state unless the caller asks to continue exploration with the same `session_id`.
- Vision mode needs a separate implementation path because text-only SDK examples do not demonstrate image admission; the plan should require an image-capable composition based on the ACP image overlay or equivalent SDK composition.
- Unrestricted mode is safety-critical and should not be reachable through model-chosen delegation. It should require explicit user invocation and produce an audit record.

## Recommended Defaults To Present

- Prefer a project-scoped Custom Tool file for v1; keep a plugin-file upgrade path for first-class opencode session/background integration.
- Use MCP only as a fallback/upgrade path, not as the v1 delivery mechanism.
- Implement four fixed tools/presets instead of a generic free-form permission/model selector.
- v1 disables DSH web tools via the JSON-RPC composition and enforces file permissions; v2 can add a custom DSH sandbox backend plugin for subprocess network denial.
- Unrestricted mode remains disabled by default and requires a confirmation token on every call.
- Write mode always receives an opencode-built context packet: objective, known relevant paths, repo summary, constraints, prior failures, expected edits, and verification commands.
