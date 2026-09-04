# deepseek-delegation-tool - Work Plan

## TL;DR (For humans)

**What you'll get:** A DeepSeek delegation tool with four explicit modes: repository exploration, workspace-limited coding, image-aware work, and a gated unrestricted escape hatch. It will return structured results, preserve session ids for follow-up, and record enough audit evidence to understand what was delegated and what happened.

**Why this approach:** The tool will use DeepSeek Harness's SDK rather than the headless CLI because the SDK gives structured results, model selection, and session continuity. The first delivery uses a project-scoped custom tool because it is the narrowest opencode integration point; a plugin or custom DSH sandbox backend can be added later if deeper background hooks or hard network blocking become necessary.

**What it will NOT do:** It will not edit opencode core, DeepSeek Harness source, or depend on headless CLI stdout. It will not claim read-only is network-safe; hard tool-side network blocking is deferred. It will not expose unrestricted mode without an explicit per-call confirmation.

**Effort:** Medium
**Risk:** Medium - the main risk is crossing three boundaries at once: opencode custom tools, Python SDK/runtime lifecycle, and DSH permission semantics.
**Decisions to sanity-check:** v1 defers hard network blocking; vision can optionally write; unrestricted is present but gated per call.

Your next move: start implementation from this plan, or run the optional high-accuracy review first. Full execution detail follows below.

---

> TL;DR (machine): Medium-risk integration plan for project-scoped `deepseek_delegate` custom tool backed by DeepSeek Harness SDK, four fixed presets, context packaging, audit logs, background jobs, and v1 file-permission safety.

## Scope
### Must have
- Add a project-scoped opencode custom tool surface under `/Users/liuzy/opencode_harness_dsh/.opencode/tools/` named `deepseek_delegate`.
- Expose four fixed presets: `explore`, `write`, `vision`, and `unrestricted`.
- Back all real DSH calls with `deepseek-harness-sdk` or the same supported SDK JSON-RPC runtime, not `dsh --profile headless`.
- Return structured results for every invocation: `job_id` when backgrounded, `session_id`, `preset`, `model`, `permission_mode`, `final_response`, `finish_reason`, `audit_path`, and error fields when applicable.
- Implement local background job lifecycle: start, output/status, and cancel. Use `bg_` style ids and persist state under `.omo/deepseek-delegate/`.
- Implement context packet management for write and vision-write tasks so DeepSeek receives a bounded, explicit task contract instead of rediscovering the repository from zero.
- Enforce schema-level restrictions for preset/model/permission combinations.
- Provide env scrubbing: pass only the explicitly required DSH/DeepSeek environment values and intentionally configured runtime variables.
- Add audit logs for all calls and stronger audit for unrestricted and image input.
- Add automated tests for schema validation, preset mapping, env scrubbing, context packet construction, background lifecycle, and failure handling.
- Add smoke tests that can run with a real DeepSeek credential when available, while keeping unit tests credential-free.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- Must not edit `/Users/liuzy/deepseek-harness` source in v1.
- Must not edit opencode core or the cached Oh My OpenAgent package.
- Must not use `dsh --profile headless` stdout/exit code as the integration protocol.
- Must not expose arbitrary model/provider/permission free-form strings to the model.
- Must not silently fall back from `deepseek-v4-flash-vision-exp` to a text-only model for vision.
- Must not claim `read-only` blocks network; built-in DSH sandbox is file-effect only.
- Must not implement hard subprocess network blocking in v1; leave a documented v2 extension path.
- Must not allow unrestricted mode without exact per-call confirmation.
- Must not parse DSH JSONL session internals as a compatibility-stable API.
- Must not allow write mode to proceed with an empty/vague task contract.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after for the custom tool and helper modules, plus credential-gated smoke tests. Use Bun/TypeScript tests for the opencode tool layer and Python tests for the SDK helper if a Python helper is introduced.
- Evidence root: `.omo/evidence/deepseek-delegation-tool/`.
- Unit tests must not call the real DeepSeek API. Stub the SDK boundary and assert exact inputs/outputs.
- Smoke tests may call the real DSH runtime only when `DEEPSEEK_API_KEY` is present and `RUN_DSH_SMOKE=1` is set.
- Each todo writes a small evidence file containing command, exit code, and assertion summary.
- Final verification must inspect the actual generated tool schema and run one failure-path invocation that never reaches the SDK.

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- Wave 1: establish project scaffolding, DSH composition assets, schema contracts, and SDK wrapper boundary.
- Wave 2: implement preset execution, context packet builder, env scrub/audit, and background lifecycle.
- Wave 3: implement vision path, unrestricted gate, failure/cancel handling, and documentation.
- Wave 4: run end-to-end smoke tests, security review, and final cleanup.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 2, 3, 4, 5 | none |
| 2 | 1 | 5, 6, 7, 8 | 3, 4 |
| 3 | 1 | 5, 6, 7 | 2, 4 |
| 4 | 1 | 8, 9 | 2, 3 |
| 5 | 2, 3 | 6, 7, 10 | 8, 9 |
| 6 | 5 | 10, 11 | 7, 8, 9 |
| 7 | 5 | 10, 11 | 6, 8, 9 |
| 8 | 2, 4 | 10, 11 | 5, 6, 7 |
| 9 | 4 | 10, 11 | 5, 6, 7, 8 |
| 10 | 6, 7, 8, 9 | 11, 12 | none |
| 11 | 10 | 12 | none |
| 12 | 11 | final verification | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Establish project scaffold and dependency boundary
  What to do / Must NOT do: Create the minimal project-owned structure for the custom tool: `.opencode/tools/`, `.opencode/package.json` or documented dependency resolution, `src/` or `scripts/` helper directory if needed, `tests/`, and `.omo/evidence/deepseek-delegation-tool/`. Pin dependency versions compatible with the installed opencode plugin API (`@opencode-ai/plugin@1.4.3`, Zod version matching local config if installed). Do not edit global opencode config, cached packages, or DeepSeek Harness source.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 2, 3, 4, 5
  References (executor has NO interview context - be exhaustive): `/Users/liuzy/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts`; `/Users/liuzy/.config/opencode/package.json`; `/Users/liuzy/opencode_harness_dsh/.omo/drafts/deepseek-delegation-tool.research.md`; Metis review in current session.
  Acceptance criteria (agent-executable): `test -d .opencode/tools && test -f .opencode/package.json && test -d .omo/evidence/deepseek-delegation-tool`; dependency file pins exact versions or documents using the already installed global dependency path.
  QA scenarios (name the exact tool + invocation): happy: `bun install` or documented no-install check succeeds and writes `.omo/evidence/deepseek-delegation-tool/task-1-happy.txt`; failure: intentionally run dependency check with missing package path in a temp copy and assert the bootstrap script reports the missing package without mutating global config, evidence `.omo/evidence/deepseek-delegation-tool/task-1-failure.txt`.
  Commit: Y | chore(scaffold): add deepseek delegate project scaffold

- [x] 2. Define exact TypeScript schema and preset capability matrix
  What to do / Must NOT do: Implement the Zod input/output schema for the custom tool and companion tools. Required input fields: `preset`, `prompt`, `cwd`, optional `session_id`, optional `run_in_background`, optional `context_packet`, optional `images`, optional `permission_mode` only where allowed, optional `confirm_unrestricted`. Presets are fixed: `explore`, `write`, `vision`, `unrestricted`. Output schema includes `status`, `preset`, `job_id?`, `session_id?`, `model`, `permission_mode`, `final_response?`, `finish_reason?`, `audit_path`, `error?`. Must not allow arbitrary model/provider strings in v1.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5, 6, 7, 8
  References: `/Users/liuzy/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts`; `/Users/liuzy/.cache/opencode/packages/node_modules/oh-my-opencode/dist/tools/delegate-task/types.d.ts`; `.omo/drafts/deepseek-delegation-tool.research.md` preset topology; Metis review missing decisions.
  Acceptance criteria: Unit test enumerates all valid/invalid preset combinations: explore forbids write permission and images; write requires context packet or explicit `allow_auto_context`; vision requires at least one image and allows read-only/workspace-write only; unrestricted requires exact confirmation token.
  QA scenarios: happy: schema accepts one canonical valid request per preset, evidence `task-2-happy.json`; failure: schema rejects arbitrary `model`, unrestricted without token, vision without image, and write without context, evidence `task-2-failure.json`.
  Commit: Y | feat(schema): define deepseek delegate preset contracts

- [x] 3. Build the SDK wrapper boundary with minimal environment allowlist
  What to do / Must NOT do: Add a helper boundary that invokes `deepseek-harness-sdk` through a stable path. Prefer a small Python helper if direct TypeScript SDK wire client would reimplement protocol. The helper must accept a JSON request on stdin and emit JSON on stdout. It must construct `DeepSeekHarness(provider, model, cwd, session_root, cordis, env, max_tokens, request_timeout_seconds)` and call `run(..., session_id=...)`. It must not inherit the full opencode process environment. Allowlist only `PATH` as needed for Python runtime, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DSH_SESSION_ROOT`, `DSH_CORDIS_CONFIG`, and any explicitly documented runtime variables.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5, 6, 7
  References: `/Users/liuzy/deepseek-harness/python/sdk/src/deepseek_harness/api.py`; `/Users/liuzy/deepseek-harness/python/sdk/README.md`; `/Users/liuzy/deepseek-harness/packages/subagent/subagent-dsh-sdk/README.md`; Metis security notes.
  Acceptance criteria: Stubbed helper test proves the generated SDK config maps `cwd`, `session_root`, `cordis`, `provider`, `model`, and `max_tokens` exactly; env scrub test proves unrelated secrets and ambient `DSH_*` names are absent unless explicitly allowed.
  QA scenarios: happy: mocked SDK returns `RunResult` and helper emits normalized JSON, evidence `task-3-happy.json`; failure: missing `DEEPSEEK_API_KEY` or SDK import failure emits structured error and nonzero exit without exposing secrets, evidence `task-3-failure.json`.
  Commit: Y | feat(sdk): add DeepSeek Harness SDK helper boundary

- [x] 4. Add project-owned DSH composition assets
  What to do / Must NOT do: Copy or generate project-owned DSH Cordis composition files under this repo, not under `/Users/liuzy/deepseek-harness`. Provide a base SDK composition derived from `examples/jsonrpc-agent/cordis.yml` and a vision overlay derived from `examples/acp-agent/image.cordis.yml` or an equivalent SDK-compatible composition. Ensure base text presets expose no DSH web tools. Ensure vision composition mounts `@deepseek-ai/dsh-attachment-local` and selects/advertises `deepseek-v4-flash-vision-exp`. Do not modify upstream files.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 8, 9
  References: `/Users/liuzy/deepseek-harness/examples/jsonrpc-agent/cordis.yml`; `/Users/liuzy/deepseek-harness/examples/acp-agent/image.cordis.yml`; `/Users/liuzy/deepseek-harness/packages/llm/llm-deepseek/README.md`; `/Users/liuzy/deepseek-harness/packages/attachment/attachment-local/README.md`.
  Acceptance criteria: Static test verifies composition files include `@deepseek-ai/dsh-sdk-jsonrpc-server`, `@deepseek-ai/dsh-llm-deepseek`, no `web_search`/`web_fetch` tool rows, and vision composition includes `@deepseek-ai/dsh-attachment-local` plus `deepseek-v4-flash-vision-exp`.
  QA scenarios: happy: composition validation/static assertions pass, evidence `task-4-happy.txt`; failure: mutate a temp copy to remove attachment-local and assert vision composition validation fails, evidence `task-4-failure.txt`.
  Commit: Y | feat(dsh): add delegate Cordis compositions

- [x] 5. Implement preset-to-runtime mapping
  What to do / Must NOT do: Implement deterministic preset mapping: `explore` -> `deepseek-official/deepseek-v4-flash`, `read-only`, text composition, no images; `write` -> `deepseek-official/deepseek-v4-flash`, `workspace-write`, text composition, context packet required; `vision` -> `deepseek-official/deepseek-v4-flash-vision-exp`, default `read-only` but allow explicit `workspace-write`, vision composition, images required; `unrestricted` -> configured default model initially `deepseek-v4-flash`, `danger-full-access`, text or vision only if images supplied, confirmation required. Must not allow model-chosen escalation.
  Parallelization: Wave 2 | Blocked by: 2, 3 | Blocks: 6, 7, 10
  References: `.omo/drafts/deepseek-delegation-tool.research.md`; `/Users/liuzy/deepseek-harness/docs/subsystems/sandbox.md`; `/Users/liuzy/deepseek-harness/docs/subsystems/approval.md`; Metis acceptance criteria.
  Acceptance criteria: Unit tests assert each preset produces exact SDK request fields, environment settings, composition path, permission mode, timeout, and model id. Unrestricted without exact token fails before helper spawn.
  QA scenarios: happy: table-driven mapping tests pass for all four presets, evidence `task-5-happy.json`; failure: invalid model/permission override and unrestricted without token produce preflight errors and no helper invocation, evidence `task-5-failure.json`.
  Commit: Y | feat(presets): map delegate modes to DSH runtime config

- [x] 6. Implement write-mode context packet builder and guardrails
  What to do / Must NOT do: Add context packet construction and validation. Required write packet fields: `objective`, `repo_summary`, `relevant_paths`, `constraints`, `expected_changes`, `verification_commands`, `non_goals`, and optional `prior_errors`, `known_failures`, `user_instructions`, `handoff_notes`. The tool may accept a caller-supplied packet or build a minimal packet from the prompt and cwd, but vague write tasks must be rejected unless `allow_auto_context: true` is explicitly set. Must not let DeepSeek start workspace-write with only a one-line ambiguous task.
  Parallelization: Wave 2 | Blocked by: 5 | Blocks: 10, 11
  References: user request for avoiding repeated exploration; oracle critique on context truncation and result authority; `.omo/drafts/deepseek-delegation-tool.research.md` planning notes.
  Acceptance criteria: Unit test renders the exact prompt sent to DSH for write mode and proves it includes objective, relevant paths, constraints, verification commands, non-goals, permission statement, and stop condition. Rejects missing `objective`, empty `relevant_paths` without `allow_auto_context`, and missing verification command unless the caller marks `verification_unavailable_reason`.
  QA scenarios: happy: write packet renders bounded task contract under a token/character cap, evidence `task-6-happy.md`; failure: vague write request is rejected before SDK spawn, evidence `task-6-failure.json`.
  Commit: Y | feat(context): add write delegation context packets

- [x] 7. Implement custom tool execute path and structured result normalization
  What to do / Must NOT do: Implement `.opencode/tools/deepseek_delegate.ts` default tool export using the schema and SDK helper. Handle sync invocation: validate, build context prompt, spawn helper, parse JSON, normalize result, write audit, return concise structured output. Must not stream raw helper logs into the model result. Must not hide non-completed `finish_reason`.
  Parallelization: Wave 2 | Blocked by: 5 | Blocks: 10, 11
  References: `/Users/liuzy/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts`; `/Users/liuzy/deepseek-harness/python/sdk/src/deepseek_harness/api.py`; `/Users/liuzy/deepseek-harness/python/sdk/README.md`; Metis result authority warning.
  Acceptance criteria: Mocked helper integration test calls the tool with explore/write and receives normalized JSON including `session_id`, `final_response`, `finish_reason`, `audit_path`; nonzero helper exit returns structured error.
  QA scenarios: happy: mocked explore invocation returns structured success and audit file exists, evidence `task-7-happy.json`; failure: malformed helper JSON returns parse error with redacted stdout/stderr preview, evidence `task-7-failure.json`.
  Commit: Y | feat(tool): implement deepseek_delegate sync execution

- [x] 8. Implement background job, output, and cancel companion tools
  What to do / Must NOT do: Add companion named exports from the same custom tool file or sibling files so opencode exposes `deepseek_delegate_output` and `deepseek_delegate_cancel` using the custom-tool multi-export naming convention. Background start returns `bg_<id>`, persists metadata under `.omo/deepseek-delegate/jobs/`, captures stdout/stderr/status, and supports cancellation through helper process termination. Must not leave orphan processes after cancellation tests.
  Parallelization: Wave 2 | Blocked by: 2, 4 | Blocks: 10, 11
  References: `/Users/liuzy/.cache/opencode/packages/node_modules/oh-my-opencode/dist/tools/background-task/`; `/Users/liuzy/.cache/opencode/packages/node_modules/oh-my-opencode/dist/features/background-agent/`; opencode custom tools docs evidence in background exploration; `/Users/liuzy/deepseek-harness/packages/subagent/subagent-dsh-sdk/README.md` shutdown ladder reference.
  Acceptance criteria: Unit/integration test starts a background stub job, polls until completed, reads result, and cancels a long-running stub job with no live child process remaining.
  QA scenarios: happy: background stub completes and output tool returns final structured result, evidence `task-8-happy.json`; failure: cancel running stub and assert status `cancelled` plus no process remains, evidence `task-8-failure.json`.
  Commit: Y | feat(background): add DeepSeek delegate job lifecycle

- [x] 9. Implement vision input admission and optional write permission
  What to do / Must NOT do: Add vision request handling: validate image paths or accepted image payload format, reject missing/nonexistent/unsupported images, choose vision composition/model, pass image content blocks to SDK helper, and allow `permission_mode: workspace-write` only when explicitly requested. Audit every image path, size, mime/type guess, and whether write permission was requested. Must not silently drop images or call a text-only model.
  Parallelization: Wave 2 | Blocked by: 4 | Blocks: 10, 11
  References: `/Users/liuzy/deepseek-harness/packages/acp/acp/README.md` image prompt support and limitations; `/Users/liuzy/deepseek-harness/examples/acp-agent/image.cordis.yml`; `/Users/liuzy/deepseek-harness/packages/attachment/attachment-local/README.md`; `/Users/liuzy/deepseek-harness/packages/llm/llm-deepseek/README.md` image model config.
  Acceptance criteria: Tests prove vision uses `deepseek-v4-flash-vision-exp`, includes image content blocks or attachment references as required by the helper, and rejects text-only routes, unsupported files, and missing images before SDK invocation.
  QA scenarios: happy: generated tiny PNG fixture is accepted and mapped to vision runtime, evidence `task-9-happy.json`; failure: `.txt` file or nonexistent image path is rejected with no SDK call, evidence `task-9-failure.json`.
  Commit: Y | feat(vision): add image-aware DeepSeek delegation

- [x] 10. Add security controls, audit logs, and user-visible caveats
  What to do / Must NOT do: Implement audit writer under `.omo/deepseek-delegate/audit/` for every call. Audit fields: timestamp, preset, cwd, session_id, model, permission_mode, image paths, context hash, env allowlist keys, helper command, finish_reason, error code, changed-file summary when available, and unrestricted confirmation marker. Tool descriptions and results must state that v1 does not hard-block tool-side network. Unrestricted confirmation token must be exact, e.g. `I_UNDERSTAND_DSH_DANGER_FULL_ACCESS`.
  Parallelization: Wave 3 | Blocked by: 6, 7, 8, 9 | Blocks: 11, 12
  References: oracle critique on auditability and unrestricted normalization; `/Users/liuzy/deepseek-harness/docs/subsystems/sandbox.md`; `/Users/liuzy/deepseek-harness/docs/subsystems/approval.md`; `/Users/liuzy/deepseek-harness/packages/subagent/subagent-dsh-sdk/README.md` env scrub.
  Acceptance criteria: Tests prove audit file is created for success and failure, unrestricted is rejected without exact token before SDK spawn, and result includes v1 network caveat for read-only/write/vision.
  QA scenarios: happy: unrestricted with token against mocked helper writes danger audit, evidence `task-10-happy.json`; failure: unrestricted without token fails preflight and audit records rejected attempt, evidence `task-10-failure.json`.
  Commit: Y | feat(security): add audit and unrestricted gates

- [x] 11. Add full test suite and credential-gated smoke tests
  What to do / Must NOT do: Add test scripts for unit tests and optional real DSH smoke. Unit suite must cover schema, mapping, context packet, env scrub, helper normalization, background lifecycle, vision validation, unrestricted gate, and audit. Smoke suite must be skipped unless `RUN_DSH_SMOKE=1` and `DEEPSEEK_API_KEY` exist. Smoke cases: explore with no tools or tiny repo; read-only write denial or preflight; workspace-write harmless file in temp workspace; vision tiny image if the SDK image path is implemented; unrestricted harmless prompt with token.
  Parallelization: Wave 3 | Blocked by: 10 | Blocks: 12
  References: all previous todos; `/Users/liuzy/deepseek-harness/docs/user/guide/python-sdk.md`; `/Users/liuzy/deepseek-harness/examples/jsonrpc-agent/minimal.py`; Metis test gaps.
  Acceptance criteria: `bun test` or chosen test command passes without credentials; smoke command clearly skips without credentials and runs with credentials when explicitly enabled.
  QA scenarios: happy: full unit test suite pass, evidence `task-11-happy.txt`; failure: run smoke without `RUN_DSH_SMOKE=1` and assert skip reason, evidence `task-11-failure.txt`.
  Commit: Y | test(delegate): cover DeepSeek delegation modes

- [x] 12. Document usage, limitations, and v2 network-hardening path
  What to do / Must NOT do: Add README or docs in the project explaining install/startup, tool arguments, four presets, confirmation token, background output/cancel flow, context packet examples, vision input examples, audit paths, and v1 security limitation. Document v2 path: custom DSH `SandboxProvider`/subprocess backend adding hard network denial for bash/tool subprocesses. Must not claim network isolation exists in v1.
  Parallelization: Wave 4 | Blocked by: 11 | Blocks: final verification
  References: `.omo/drafts/deepseek-delegation-tool.research.md`; `/Users/liuzy/deepseek-harness/packages/sandbox/sandbox-local/README.md`; `/Users/liuzy/deepseek-harness/packages/shell/bash-sandbox/README.md`; oracle critique.
  Acceptance criteria: Documentation includes one valid example per preset, one invalid unrestricted example, exact smoke-test command, exact audit directory, and explicit statement that v1 read-only/workspace-write do not block network.
  QA scenarios: happy: docs examples pass schema validation through a docs-example test, evidence `task-12-happy.txt`; failure: docs contain the required network caveat and unrestricted warning, checked by test or script, evidence `task-12-failure.txt`.
  Commit: Y | docs(delegate): document DeepSeek delegation tool

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Verify all 12 todos are implemented, every Must Have is covered, every Must NOT Have remains true, and no files outside `/Users/liuzy/opencode_harness_dsh` were edited except generated dependency artifacts explicitly required by project bootstrap. Evidence `.omo/evidence/deepseek-delegation-tool/final-plan-compliance.md`.
- [x] F2. Code quality review
  Review custom tool/helper code for schema correctness, typed errors, no credential leaks, no broad env inheritance, no unbounded output capture, no orphan process risks, and no arbitrary model/permission escape. Evidence `.omo/evidence/deepseek-delegation-tool/final-code-quality.md`.
- [x] F3. Real manual QA
  Run the actual opencode tool load/invocation path if available; otherwise run the closest CLI/test harness that imports the custom tool exactly as opencode would. Include at least one preflight failure that never reaches DSH. Evidence `.omo/evidence/deepseek-delegation-tool/final-manual-qa.md`.
- [x] F4. Scope fidelity
  Confirm v1 does not implement or claim hard network blocking, does not edit DeepSeek Harness source, does not rely on headless CLI, and does not expose ungated unrestricted mode. Evidence `.omo/evidence/deepseek-delegation-tool/final-scope-fidelity.md`.

## Commit strategy

- Commit only after the final verification wave passes.
- Keep commits atomic in the order shown by todo commit lines if the user requests commits; otherwise leave changes unstaged.
- Do not include credentials, `.env`, real DSH session logs containing private content, or generated smoke artifacts that include model responses unless intentionally sanitized.
- Expected final commit message if squashed: `feat(delegate): add DeepSeek Harness delegation tool`.

## Success criteria

- `deepseek_delegate` is available from the project-scoped opencode custom tool surface.
- `explore` maps to DeepSeek V4 Flash, read-only file mode, no images, structured repository summary output.
- `write` maps to DeepSeek V4 Flash, workspace-write mode, required context packet, and structured work/test summary.
- `vision` maps to `deepseek-v4-flash-vision-exp`, validates image input, supports optional workspace-write, and refuses text-only fallback.
- `unrestricted` cannot run without the exact confirmation token and always records a danger audit.
- Background start/output/cancel works with persisted job state.
- Env scrubbing passes only required DeepSeek/DSH variables and drops unrelated secrets.
- Unit tests pass without credentials; smoke tests are opt-in and skip clearly without credentials.
- Documentation makes the v1 network limitation explicit and names the v2 hardening path.
