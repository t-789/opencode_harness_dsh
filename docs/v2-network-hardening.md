# v2 design note: hard network denial for delegated runs

Status: planned, not implemented in v1. v1 confines **file** effects only; the delegated
agent can still make outbound network requests (see the README caveat).

## Why v1 cannot block network

The DSH sandbox is a **file-effect seam**. `SandboxMode`
(`read-only` / `workspace-write` / `danger-full-access`) expresses only filesystem
grants, and the backend docs state the boundary directly: "File effects are the whole
policy vocabulary: the seam expresses no network, process, syscall, device, or credential
restrictions." References (read-only, do not edit upstream):

- `/Users/liuzy/deepseek-harness/packages/sandbox/sandbox/README.md` (Known Limitations)
- `/Users/liuzy/deepseek-harness/docs/subsystems/sandbox.md` (Modes and enforcement)
- `/Users/liuzy/deepseek-harness/packages/sandbox/sandbox-local/README.md` (per-platform
  profile builders: Seatbelt on macOS, bwrap/Landlock on Linux)

Current enforcement layer for our presets: the sandboxed compositions in
`dsh/cordis/base.cordis.yml` and `dsh/cordis/vision.cordis.yml`, which mount
`@deepseek-ai/dsh-sandbox-local` + `dsh-sandbox-policy` + `dsh-bash-sandbox` +
`dsh-fs-sandbox` + `dsh-user-approval` (policy `never`).

## v2 design: a custom SandboxProvider

`ctx.sandbox.confine(argv, policy)` must return a wrapped argv that enforces, or fail
closed with `SANDBOX_UNAVAILABLE`; unconfined passthrough is forbidden. v2 registers a
project-owned `SandboxProvider` subclass in the composition (replacing the
`@deepseek-ai/dsh-sandbox-local` row) whose `confine()` produces runner argv with file
grants **plus hard network denial**:

- **macOS**: a project-owned Seatbelt profile derived from the sandbox-local builder's
  shape (allow-default, `(deny file-write*)` + mode write allow-lists) extended with
  `(deny network*)` so confined bash subprocesses lose sockets entirely.
- **Linux**: `bwrap` with `--unshare-net` on top of the existing read-only-root /
  workspace-bind profile; a fresh net namespace with no `lo` up is a hard egress block.

The provider returns the wrapped argv with honest `enforcement`, `denialSignatures`, and
`runnerFailureRules` so consumers classify network denials as policy, not command bugs.
The ACP example's snapshot fixture shows the custom-provider subclass pattern:
`/Users/liuzy/deepseek-harness/examples/acp-agent/tests/fixtures/partial-landlock-sandbox.ts`.

Composition wiring keeps the row-order constraint (sandbox and sandbox-policy rows
before the bash/fs consumers). `unrestricted` (`danger-full-access`) bypasses the seam by
design and is out of scope for hardening.

## Verification plan

Add a fourth smoke scenario: a read-only delegation instructed to `curl` an external
host must fail with the backend's network-denial evidence, and the same confinement must
leave the workspace-write file grant intact.
