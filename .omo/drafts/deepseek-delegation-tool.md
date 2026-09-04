---
slug: deepseek-delegation-tool
status: plan-written
intent: clear
pending-action: write .omo/plans/deepseek-delegation-tool.md
approach: project-scoped opencode custom tool backed by deepseek-harness-sdk, with four fixed presets and v1 file-permission isolation; hard subprocess network blocking deferred.
---

# Draft: deepseek-delegation-tool

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

| id | outcome | status | evidence path |
| --- | --- | --- | --- |
| C1 | Project-scoped opencode tool `deepseek_delegate` with schema, sync/background/cancel/output surfaces. | active | `.omo/drafts/deepseek-delegation-tool.research.md` |
| C2 | SDK wrapper around DeepSeek Harness with controlled env, sessions, result normalization, errors, and audit logs. | active | `/Users/liuzy/deepseek-harness/python/sdk/src/deepseek_harness/api.py` |
| C3 | Four presets: explore, write, vision, unrestricted. | active | `.omo/drafts/deepseek-delegation-tool.research.md` |
| C4 | Context packet builder for write/vision-write tasks. | active | user request + Metis review |
| C5 | Safety controls: schema gates, env scrub, v1 network caveat, unrestricted audit, v2 hard-net placeholder. | active | DSH sandbox/approval docs |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

| assumption | adopted default | rationale | reversible? |
| --- | --- | --- | --- |
| v1 integration surface | `.opencode/tools/deepseek_delegate.ts` custom tool | lower risk than MCP/plugin; schema and arbitrary execute code are enough for v1 | yes |
| SDK invocation | TypeScript custom tool shells to a Python helper using `deepseek-harness-sdk` | SDK is official programmatic surface with `RunResult` and session ids | yes |
| hard network blocking | deferred to v2 | user selected v1 without hard tool-side network block | yes |
| unrestricted | per-call confirmation token and audit | user selected per-call confirmation | yes |
| vision permission | optional `workspace-write` | user selected optional write | yes |

## Findings (cited - path:lines)

- `/Users/liuzy/deepseek-harness/python/sdk/src/deepseek_harness/api.py`: SDK exposes `DeepSeekHarnessConfig(provider, model, cwd, session_root, cordis, env, ...)`, `RunResult(session_id, final_response, finish_reason, events, notifications)`, and `run(..., session_id=...)`.
- `/Users/liuzy/deepseek-harness/docs/user/guide/python-sdk.md`: reusing the same harness and session id preserves the session-owned conversation and persistent bash state.
- `/Users/liuzy/deepseek-harness/examples/jsonrpc-agent/cordis.yml`: SDK JSON-RPC composition exposes bash, fs tools, subagent, todo, persistence, compaction, and no web_search/web_fetch.
- `/Users/liuzy/deepseek-harness/examples/acp-agent/image.cordis.yml`: vision overlay selects `deepseek-v4-flash-vision-exp` and mounts `@deepseek-ai/dsh-attachment-local`.
- `/Users/liuzy/deepseek-harness/packages/llm/llm-deepseek/README.md`: DeepSeek adapter advertises `deepseek-v4-flash-vision-exp` with `inputModalities: [text, image]`; image input requires attachments.
- `/Users/liuzy/deepseek-harness/docs/subsystems/sandbox.md`: DSH sandbox modes govern file effects only; network is outside the built-in vocabulary.
- `/Users/liuzy/deepseek-harness/docs/subsystems/approval.md`: approval is fail-closed; only `allowed-once` grants.
- `/Users/liuzy/deepseek-harness/packages/subagent/subagent-dsh-sdk/README.md`: DSH already has a subagent SDK provider that scrubs credential-shaped and `DSH_*` parent env, proving the subprocess/SDK boundary pattern.
- `/Users/liuzy/.config/opencode/docs/features.md`: opencode/Oh My OpenAgent has MCP and background-agent patterns; custom tools and plugin tools are valid extension surfaces.
- Metis review: v1 must plan a project-scoped custom tool, exact schema, env scrub, unrestricted audit, and explicit tests for preset mapping and failure paths.

## Decisions (with rationale)

- Build a project-scoped custom tool first, not MCP. Rationale: lower config surface, direct Zod schema, no extra protocol hop.
- Use DeepSeek Harness Python SDK, not headless CLI. Rationale: structured result, session id, model/provider selection, reusable runtime.
- Implement four fixed presets rather than free-form model/permission knobs. Rationale: lowers accidental privilege/model mismatch.
- Defer hard tool-side network blocking to v2. Rationale: user selected v1 without it; built-in DSH sandbox only handles file effects.
- Treat read-only as file-read-only, not network-safe. Rationale: DSH docs explicitly say network remains unrestricted.
- Require audit output for every invocation, with stronger audit for unrestricted and vision image inputs.

## Scope IN

- Project files under `/Users/liuzy/opencode_harness_dsh` only.
- `.opencode/tools/deepseek_delegate.ts` plus support files needed for dependency/bootstrap.
- Python helper code or wrapper scripts needed to drive `deepseek-harness-sdk`.
- DSH composition files copied/pinned under this project when needed, rather than editing `/Users/liuzy/deepseek-harness`.
- Four preset schemas and exact mode/model/permission mapping.
- Sync execution and local background job/output/cancel companion surfaces.
- Context packet builder and validation for write/vision-write.
- Audit logs and `.omo/evidence` verification artifacts.

## Scope OUT (Must NOT have)

- No edits to opencode core, Oh My OpenAgent package cache, or DeepSeek Harness source in v1.
- No headless CLI protocol dependency.
- No generic arbitrary model selector in v1.
- No claim that read-only blocks network.
- No ungated unrestricted mode.
- No silent fallback from vision model to text-only model.
- No hard subprocess network blocking in v1; document as deferred v2.
- No parsing of DSH JSONL session internals as a supported API.

## Open questions

None blocking. User resolved the owner decisions: v1 can defer hard network blocking; unrestricted uses per-call confirmation; vision may optionally write; v1 target is a project-scoped custom tool.

## Approval gate
status: approved-to-write-plan
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
