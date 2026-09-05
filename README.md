# deepseek-delegate

A project-scoped opencode custom tool that delegates bounded tasks to DeepSeek models
through the **DeepSeek Harness (DSH) runtime**. Every JSON block in this README tagged
`delegate`, `delegate-invalid`, or `output` is schema-checked by
`tests/docs-examples.test.ts`, which reads this file directly. Keep the examples and the
code in sync; the test fails if they drift.

> ## Read this first: v1 security limitation
>
> explore, write, and vision confine **file effects** through the DSH sandbox:
> `read-only` denies writes, `workspace-write` confines writes to the workspace, and any
> escalation attempt is auto-rejected (the runtime runs unattended with approval policy
> `never`). **v1 does NOT hard-block network access from the delegated agent.** The DSH
> sandbox is a file-effect seam; network is outside its vocabulary. Do not delegate tasks
> over sensitive networks expecting egress isolation. See
> [Security model and the v1 network limitation](#security-model-and-the-v1-network-limitation)
> and the planned fix in [docs/v2-network-hardening.md](docs/v2-network-hardening.md).

## What it is

Running `opencode` inside this directory loads four custom tools from `.opencode/tools/`:

| Tool | Purpose |
| --- | --- |
| `deepseek_delegate` | Start one bounded delegation (sync or background) |
| `deepseek_delegate_output` | Poll one background job for status, progress, or the final result |
| `deepseek_delegate_wait` | Wait once for a background job to finish, returning the terminal result |
| `deepseek_delegate_cancel` | Stop one running background job (SIGTERM, then SIGKILL to its process group) |

A delegation is **not** a raw model call. The tool spawns the DeepSeek Harness runtime
(over the `@deepseek-ai/dsh-sdk-client` JSON-RPC bridge in `scripts/delegate-runner.ts`)
and lets a real agent work inside your workspace. That agent gets filesystem and bash
tools confined by the DSH sandbox policy, session continuity for follow-up turns,
subagents, todo tools, and context compaction. You give it a bounded task; it comes back
with a structured result, a session id, and an audit record.

Flow: `deepseek_delegate` (schema validation, preset mapping, context rendering, vision
admission) → `src/jobs.ts` `JobManager` (detached child, state on disk) →
`scripts/delegate-runner.ts` (env-scrubbed bridge, one JSON result line) → DSH runtime
booted from a project-owned Cordis composition (`dsh/cordis/*.cordis.yml`).

## The four presets

Presets are fixed. You cannot pass a free-form `model`, `provider`, or escalate through
`permission_mode`: the input schema has no model/provider fields at all, and each preset
only accepts its own permission subset.

| Preset | Model | File-effect mode | Hard requirements | Intended use |
| --- | --- | --- | --- | --- |
| `explore` | `deepseek-v4-flash` | `read-only` (only value accepted) | none; images are rejected | repository analysis, summaries, audits |
| `write` | `deepseek-v4-flash` | `workspace-write` (only value accepted) | `context_packet` **or** `allow_auto_context: true`; images are rejected | bounded implementation work inside the workspace |
| `vision` | `deepseek-v4-flash-vision-exp` | `read-only` by default; `workspace-write` only when explicitly requested; `danger-full-access` rejected | at least one image; supported types: png, jpg, jpeg, webp, gif | image-aware analysis, optionally with edits |
| `unrestricted` | `deepseek-v4-flash` | `danger-full-access` (no caller override allowed) | `confirm_unrestricted` must equal the exact token `I_UNDERSTAND_DSH_DANGER_FULL_ACCESS` | gated escape hatch, not for casual use |

Every call also carries a `cwd` (relative paths resolve against the opencode session
directory) and optional `session_id`, `run_in_background`, `max_tokens`, and `timeout_ms`.

`unrestricted` is deliberately awkward on purpose: no file or network confinement at all,
so the schema refuses the preset unless the caller repeats the exact confirmation token,
and every unrestricted attempt gets a dedicated marker in the audit ledger.

## Install and setup

1. **Install dependencies** at the repo root:

   ```bash
   bun install
   ```

   The tool depends on the local DeepSeek Harness runtime packages, installed as project
   dependencies pinned to a coherent `0.0.1-rc.5` closure (client, JSON-RPC server and
   demo runtime, sandbox, bash, fs, session, subagent, attachment packages, and friends).
   The DSH runtime bin resolves from `node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js`;
   set `DSH_RUNTIME_BIN` to point somewhere else if needed.

2. **Trust the two lifecycle scripts** or the sandboxed runtime degrades:

   ```bash
   bun pm trust @deepseek-ai/dsh-subprocess-local koffi
   ```

   (`dsh-subprocess-local` chmods the node-pty `spawn-helper`; `koffi` fetches the native
   FFI prebuild used by the fs and session persistence layers.)

3. **Provide the credential** in the environment opencode runs with:

   ```bash
   export DEEPSEEK_API_KEY="your-key"      # required
   export DEEPSEEK_BASE_URL="..."          # optional endpoint override
   ```

   Keys are only ever passed through the environment allowlist
   (`PATH`, `HOME`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, plus the four `DSH_*` slots
   the bridge sets per call). Nothing else from the ambient environment reaches the
   delegated agent, and credentials never appear in tool arguments or audit files.

4. **Run opencode in this directory.** Custom tools under `.opencode/tools/` are
   project-scoped: opencode auto-loads `deepseek_delegate`, `deepseek_delegate_output`,
   `deepseek_delegate_wait`, and `deepseek_delegate_cancel` from here. No global config
   changes are involved.

## Usage

Ask opencode to delegate, or call the tool directly. Argument shapes below are the real
schema (`deepseekDelegateInputSchema` in `src/schema.ts`).

### explore: one synchronous analysis

```json delegate
{
  "preset": "explore",
  "prompt": "Summarize the module layout and data flow of this repository.",
  "cwd": "."
}
```

### explore in the background, then wait or inspect progress

Start (returns immediately with a `bg_` job id and `status: "running"`):

```json delegate
{
  "preset": "explore",
  "prompt": "Audit every exported symbol in src/ and list the unused ones.",
  "cwd": ".",
  "run_in_background": true,
  "timeout_ms": 900000
}
```

Then wait once with `deepseek_delegate_wait` when the next step depends on the result:

```json
{
  "job_id": "bg_a1b2c3d4e5f6",
  "timeout_ms": 900000
}
```

This is the lowest-chatter continuation path: the caller blocks in one tool call and the
tool checks job state on the shared 10 second cadence. A timeout ends the wait but leaves
the background job running, so you can wait again, inspect progress, or cancel it.

Use `deepseek_delegate_output` only when you need a progress snapshot:

```json
{
  "job_id": "bg_a1b2c3d4e5f6"
}
```

While the job runs you get a snapshot with capped, redacted progress tails:

```json
{
  "ok": true,
  "view": {
    "job_id": "bg_a1b2c3d4e5f6",
    "output": {
      "status": "running",
      "preset": "explore",
      "job_id": "bg_a1b2c3d4e5f6",
      "model": "deepseek-v4-flash",
      "permission_mode": "read-only",
      "audit_path": "/path/to/.omo/deepseek-delegate/audit/bg_a1b2c3d4e5f6.json"
    },
    "stdout_tail": "",
    "stderr_tail": ""
  }
}
```

When the job is done, both `deepseek_delegate_wait` and `deepseek_delegate_output` return
the final structured result (shape below). Stop a job that is no longer interesting with
`deepseek_delegate_cancel`, using the same
`{ "job_id": "..." }` argument: a terminal `cancelled` record comes back, and the whole
detached process group (runner plus DSH runtime tree) is gone. Cancelling a job that
already finished returns `{"ok": false, "error": {"code": "JOB_NOT_RUNNING", ...}}`.

### write: bounded implementation work with a context packet

`write` refuses to run on a vague one-liner. Supply a `context_packet` so the agent
implements your contract instead of rediscovering the repository from zero:

```json delegate
{
  "preset": "write",
  "prompt": "Implement the task contract below.",
  "cwd": ".",
  "context_packet": {
    "objective": "Add a small CLI script that prints the audit record for one job id.",
    "repo_summary": "TypeScript + Bun project. Core modules under src/, opencode tools under .opencode/tools/, bridge under scripts/.",
    "relevant_paths": ["src/audit.ts", "src/schema.ts", "scripts/"],
    "constraints": "No new npm dependencies. Do not edit files outside this repo.",
    "expected_changes": "One new script file plus a package.json script entry.",
    "verification_commands": ["bun test", "bunx tsc --noEmit -p tsconfig.json"],
    "non_goals": "No changes to the schema or the preset matrix."
  }
}
```

If you skip the packet you must say so explicitly with `allow_auto_context: true`:

```json delegate
{
  "preset": "write",
  "prompt": "Rename the misnamed helper in src/audit.ts and update its call sites.",
  "cwd": ".",
  "allow_auto_context": true
}
```

A `write` call with neither is rejected before anything spawns:

```json delegate-invalid
{
  "preset": "write",
  "prompt": "make it better",
  "cwd": "."
}
```

### vision: image-aware delegation

Images are paths (absolute, or relative to `cwd`) of real files that pass admission:
regular file, nonzero, extension in png/jpg/jpeg/webp/gif, and magic bytes matching the
extension. Duplicates are rejected.

```json delegate
{
  "preset": "vision",
  "prompt": "Describe the layout problems in this UI mockup.",
  "cwd": ".",
  "images": ["./examples/mockup.png"]
}
```

Vision writes are opt-in with `permission_mode: "workspace-write"` (still confined to
the workspace; `danger-full-access` is never accepted here):

```json delegate
{
  "preset": "vision",
  "prompt": "Transcribe the whiteboard photo into a new notes/whiteboard.md.",
  "cwd": ".",
  "images": ["/tmp/whiteboard.jpg"],
  "permission_mode": "workspace-write"
}
```

Note: the block shape sent to the runtime is the correct rc.5 `image` +
`ImageAttachmentRef` contract, but durable image resolution end to end additionally
depends on the runtime attachment store registering the content-addressed id
(see the documented residual risk in `src/vision.ts`).

### unrestricted: gated escape hatch

Runs with `danger-full-access`: no file confinement and no network isolation. Requires
the exact confirmation token on every call, and always writes a flagged audit record.

```json delegate
{
  "preset": "unrestricted",
  "prompt": "Inspect the machine-wide npm cache layout and report which entries are stale.",
  "cwd": ".",
  "confirm_unrestricted": "I_UNDERSTAND_DSH_DANGER_FULL_ACCESS"
}
```

Without the token (or with a typo, or with a caller-set `permission_mode`) the schema
rejects the call before anything is spawned:

```json delegate-invalid
{
  "preset": "unrestricted",
  "prompt": "Inspect the machine-wide npm cache and report stale entries.",
  "cwd": "."
}
```

### Follow-up turns: session continuity

Every completed run reports a `session_id`. Pass it back to continue inside the same DSH
session (the agent keeps its history and context):

```json delegate
{
  "preset": "explore",
  "prompt": "Now compare the two services you found and list the coupling risks.",
  "cwd": ".",
  "session_id": "0f9c1f2e-8a3d-4f6b-a7f8-90c2d1e3f4a5"
}
```

### Reading the result

Every `deepseek_delegate` call returns one JSON object (the `DelegateOutput` schema).
Synchronous runs wait for the job (default budget 10 minutes, or your `timeout_ms`) and
cancel it if the deadline passes.

```json output
{
  "status": "completed",
  "preset": "explore",
  "job_id": "bg_a1b2c3d4e5f6",
  "session_id": "0f9c1f2e-8a3d-4f6b-a7f8-90c2d1e3f4a5",
  "model": "deepseek-v4-flash",
  "permission_mode": "read-only",
  "finish_reason": "completed",
  "final_response": "The repository has four layers...",
  "audit_path": "/path/to/.omo/deepseek-delegate/audit/bg_a1b2c3d4e5f6.json"
}
```

- `status`: `completed`, `error`, `cancelled`, or `running` (background start/poll).
  `completed` is only ever echoed from a runner that printed an ok result and exited 0;
  the tool never synthesizes it.
- `finish_reason`: surfaced verbatim from the runtime turn-end event
  (`completed`, `max-tokens`, `error`, `aborted`, `blocked`, `interrupted`, `unknown`).
  A non-`completed` reason is never hidden.
- `final_response`: the agent's report, capped at 4000 chars with a visible truncation
  marker, credential-redacted.
- `error`: `{ code, message }` on failures, e.g. `SCHEMA_INVALID`,
  `UNRESTRICTED_CONFIRMATION_REQUIRED`, `WRITE_CONTEXT_REQUIRED`, `PREFLIGHT`, `TIMEOUT`.

```json output
{
  "status": "error",
  "preset": "write",
  "model": "deepseek-v4-flash",
  "permission_mode": "workspace-write",
  "error": {
    "code": "SCHEMA_INVALID",
    "message": "input violates the deepseek_delegate contract: context_packet: preset \"write\" requires a context_packet or allow_auto_context: true"
  },
  "audit_path": "/path/to/.omo/deepseek-delegate/audit/preflight-2026-09-04T09-15-02-123Z-9f2c.json"
}
```

## Context packets

A context packet is a bounded, explicit task contract for `write` runs. It exists so the
delegated agent starts from your knowledge of the repository instead of burning time (and
tokens) re-exploring it.

| Field | Required | Why it matters |
| --- | --- | --- |
| `objective` | yes | the single thing to accomplish |
| `repo_summary` | no | orientation; truncated first when the packet is long |
| `relevant_paths` | no | where to work; without it you need `allow_auto_context` |
| `constraints` | no | rules the run must not break |
| `expected_changes` | no | the intended diff, stated up front |
| `verification_commands` | no | how the agent proves its work; if omitted, the rendered contract carries an explicit "no verification commands supplied, verify manually" warning |
| `non_goals` | no | scope the agent must not expand into |
| `prior_errors`, `known_failures`, `user_instructions`, `handoff_notes` | no | extra context for tricky or resumed work |

The packet is rendered into a markdown contract that also carries a stop condition and
the permission statement (writes are confined; escalation is auto-rejected). The render
is capped at 12,000 characters: `repo_summary` and `handoff_notes` truncate first (with a
visible `[truncated]` marker); if the rest still overflows, the call fails with
`CONTEXT_TOO_LARGE` rather than silently cutting non-negotiable fields.

`allow_auto_context: true` is the escape hatch for small, obvious tasks. It wraps your
prompt in a bounded "map the relevant areas first, do not survey the whole repository"
instruction. It is weaker than a real packet: expect more exploration and looser scope.
Vague write requests are rejected without it, and never run on a one-liner contract.

## Background jobs

Background state lives in this project under `.omo/deepseek-delegate/jobs/`, one artifact
set per job:

- `<job_id>.json`: the job record (status, preset, model, permission mode, pids, result)
- `<job_id>.request.json`: the exact bridge request (this is what `audit_path`'s
  `helper_command` replay hint references)
- `<job_id>.out` / `<job_id>.err`: the child's stdout and stderr

Job ids look like `bg_a1b2c3d4e5f6`. The runner starts as a **detached** child, so jobs
survive opencode restarting; a job whose process died without being settled is
reconstructed from its `.out` file the next time you poll. Output reads are tail-capped
and redacted, never unbounded. `deepseek_delegate_cancel` SIGTERMs the job's process
group, waits a short grace window, then SIGKILLs, and only records `cancelled` after the
process is reaped. Terminal states are immutable. Synchronous runs use the same machinery
and simply wait for the terminal state.

## Audit records

Every invocation writes one audit record under `.omo/deepseek-delegate/audit/` (the whole
`.omo/deepseek-delegate/` tree is gitignored). Job-backed attempts write
`<job_id>.json`; calls rejected before a job existed write
`preflight-<timestamp>-<hex>.json`. The returned `audit_path` points at the real file.

The record is a **metadata ledger**, never a transcript. Recorded:

- timestamp, preset, cwd, model, permission mode, `session_id`/`job_id` when present
- image **paths** (never image contents)
- `context_hash`: a sha256 fingerprint of the effective prompt/content blocks (one-way;
  it lets you match two attempts without storing the text)
- the env-allowlist **key names**, the helper command replay hint
- outcome: `finish_reason`, or `error_code` plus a redacted, capped `error_message`
- `unrestricted_confirmation`: true only when the exact token was verified at the schema
  layer (the token itself is never recorded)
- `network_caveat_v1: true` on every record, the standing reminder that v1 confines
  files, not network

Never recorded: prompts, context packet bodies, API keys, final responses. The audit
writer re-redacts and never throws: an audit failure cannot change a delegation result.

## Testing

```bash
bun test              # everything, credential-free; the smoke file self-skips with a clear reason
bun run test:unit     # same, but fully excludes tests/smoke.test.ts
bun run test:smoke    # real live-runtime smoke, see below
```

The unit suite covers the schema matrix, preset mapping, context packet rendering and
guardrails, env scrubbing, bridge normalization, background lifecycle (start/wait/poll/cancel
with real detached stubs), vision admission, the unrestricted gate, the audit ledger, and
the README examples in this file.

Smoke tests call the **real** DeepSeek runtime and only run when **both**
`RUN_DSH_SMOKE=1` and a real `DEEPSEEK_API_KEY` are present:

```bash
RUN_DSH_SMOKE=1 DEEPSEEK_API_KEY="your-key" bun run test:smoke
```

The three smoke scenarios prove end to end, with no stubs:

1. **explore happy path**: a real read-only delegation completes and its final response
   carries the agreed marker.
2. **read-only enforcement**: a read-only delegation is told to write a probe file; the
   file must not exist afterwards and the agent must report the sandbox denial. This is
   live proof the file sandbox is enforced, not decorative.
3. **workspace-write**: a `write` run with a context packet must create its file inside a
   fresh temp workspace, proving the confined-write grant works.

Each run gets a temp workspace and jobs dir, cleans up its session artifacts, and the
suite fails if any child process survives. Per-run budget: `DSH_SMOKE_TIMEOUT_MS`
(default 240000 ms).

## Security model and the v1 network limitation

What v1 **does** enforce, through the project-owned Cordis compositions
(`dsh/cordis/base.cordis.yml`, `dsh/cordis/vision.cordis.yml`) that mount the sandboxed
DSH stack:

- `@deepseek-ai/dsh-sandbox-policy` maps the per-call mode (`read-only`,
  `workspace-write`) onto file grants; the deployment default is `read-only`.
- `@deepseek-ai/dsh-bash-sandbox` and `@deepseek-ai/dsh-fs-sandbox` run every shell
  command and fs mutation confined to those grants. A
  `[sandbox: file access denied ...]` result is policy, not a bug.
- `@deepseek-ai/dsh-user-approval` uses policy `never`: the unattended runtime has no
  interactive approver, so any escalation attempt is deterministically rejected.
- The bridge replaces the child environment entirely (eight-key allowlist) and redacts
  credential-shaped text on every path back to the model.

What v1 **does not** do: **block network access.** The DSH sandbox seam is a file-effect
mechanism, and its own documentation states plainly that network, process, syscall,
device, and credential restrictions are outside its vocabulary. A delegated agent can
make outbound network requests from inside its file grant. Treat `read-only` and
`workspace-write` as *file* safety guarantees only. If the delegated agent runs somewhere
with access to a sensitive network, assume it can reach that network.

`unrestricted` is the opposite end: `danger-full-access` bypasses confinement entirely,
which is why the exact per-call token and the audit marker exist.

## v2: hardening the network boundary

The planned fix is a project-owned DSH `SandboxProvider` backend that wraps subprocesses
with hard network denial (macOS Seatbelt `(deny network*)`, Linux `bwrap --unshare-net`)
registered in the same compositions. The design note, seams, and verification plan are in
**[docs/v2-network-hardening.md](docs/v2-network-hardening.md)**.

## Project layout

```
.opencode/tools/deepseek_delegate.ts   the custom tools (default + output + wait + cancel exports)
src/schema.ts                          input/output/job Zod schemas, preset capability matrix
src/preset-map.ts                      validated input -> exact bridge request + metadata
src/context.ts                         write context packet rendering and guardrails
src/vision.ts                          image admission, magic-byte probing, content blocks
src/jobs.ts                            background job lifecycle (detached runner children)
src/delegate-execute.ts                sync/execute core (validation, mapping, polling)
src/audit.ts                           metadata-only audit ledger writer
scripts/delegate-runner.ts             executable bridge: one JSON request -> one JSON line
scripts/runner-lib.ts                  env allowlist/scrubber, request parsing, redaction
dsh/cordis/base.cordis.yml             sandboxed composition for text presets
dsh/cordis/vision.cordis.yml           same + durable attachment store for images
tests/                                 unit suite + credential-gated smoke + docs-examples
docs/v2-network-hardening.md           v2 design note (hard network denial path)
.omo/deepseek-delegate/                runtime state: jobs/, audit/, sessions/ (gitignored)
```
