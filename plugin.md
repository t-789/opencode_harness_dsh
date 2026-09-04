有帮助，而且对这个任务来说，**"写 plugin"基本就是官方期望的正确路径**，比 fork core 或硬啃 headless CLI 更合适。

但要说清楚：plugin 能解决"接入表面"的问题，不能解决"发布承诺/底层能力"的问题。

## 为什么 plugin 路线是对的

`docs/architecture.md` 说得很直白：

> There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.

而且现在这些集成入口本身就是 plugin/bundle：

- `dsh-headless` 就是一个 bundle，核心是 `headless-startup` + `headless-runner` 两个 plugin（`packages/bundle/headless/src/index.ts`、`startup.ts`）。
- ACP 是 `@deepseek-ai/dsh-acp` 这个 transport plugin（`packages/acp/acp/README.md`）。
- Python SDK 的运行时是 `@deepseek-ai/dsh-sdk-jsonrpc-server` 这个 plugin，通过一份 `cordis.yml` 组装（`examples/jsonrpc-agent/cordis.yml`）。
- `dsh-base` 里的模型适配器、工具、session 持久化、sandbox、approval，全都是 plugin 行（`packages/bundle/base/cordis.patch.yml`）。

所以"opencode 想以 subagent 形式调用 DSH"本质上就是一个 **plugin 组合/新 bundle 设计问题**，而不是核心改造问题。

## 前 7 个问题里，plugin 分别能补什么

| 问题 | plugin 能做什么 | 参考机制 |
|---|---|---|
| 1. 嵌入姿态 | 写一个 ACP/JSON-RPC stdio **protocol driver**，像 `dsh-acp` 一样服务父 agent；甚至直接装 `@deepseek-ai/dsh-subagent-acp` | `docs/cookbook/extension-cookbook.md` 的 "external protocol driver"；`packages/acp/acp/README.md` |
| 2. 会话续接 | 写 startup/runner plugin，用 `ctx.sessionPersistence.load` + `ctx.sessions.create(id, { seed })`（或 `ctx.agents.resume`）恢复 session，再暴露 `--resume` | `packages/session/session-persistence-jsonl/README.md`；`docs/architecture.md` |
| 3. 机器可读输出 | 写自己的 runner，把 session id / final text / `turn/end` reason / `assistant/message.usage` 序列化成 JSON 打到 stdout | headless runner 的 `summarize()` 就是现成模板（`packages/bundle/headless/src/index.ts`） |
| 4. 模型选择 | startup plugin 解析 `--model`/`--tier` 并发布 service；runner 创建 Agent 时把选择注入 scoped model selection；或写 `LlmAdapter` 注册 longxia 路由 | `packages/boot/cmdline/README.md`；`packages/core/agent-default-model/README.md`；`docs/cookbook/adding-an-llm-adapter.md` |
| 5. 并发 | 一般不需要新 plugin；需要的话可以加 session-id 分配/锁插件。现有 JSONL 已按 session 隔离，credentials 写有跨进程锁 | `packages/session/session-persistence-jsonl/README.md`；`packages/util/atomic-write/README.md` |
| 6. 取消 | protocol driver 自己实现 `session/cancel` + `AgentHandle.dispose()`；headless 的 5s drain 已经由 `ctx.appExit` 接入，plugin 可以复用 | `packages/acp/acp/README.md`；`apps/cli/src/process-shutdown.ts` |
| 7. 网络 | 用 `tools/pre-execute` 拦截/deny 网络类工具；更硬的方案是提供自定义 `ctx.sandbox`/`ctx.subprocess` backend，把命令包进 network namespace/防火墙 | `docs/cookbook/extension-cookbook.md` 的 hook 例子；`docs/subsystems/sandbox.md` |

## 最值得做的 plugin 形态

如果要给 opencode 做，我会建议做成一个 **`dsh-opencode` bundle**，而不是零散改配置：

1. **一个 `opencode-startup` plugin**：`inject: ['cmdlineArgs']`，用 commander 解析自己的 app 参数，例如
   - `--json`
   - `--resume <session-id>`
   - `--model <id>` / `--tier flash|reasoning`
   - `--session-root <path>`

   这正是 `headless-startup` / `web-startup` 的现有模式（`packages/boot/cmdline/README.md`）。

2. **一个 `opencode-runner` plugin**：注入 `agentDefaultModel`、`agents`、`sessions`、`sessionPersistence`，按参数创建或恢复 Agent，等 quiescence，flush，输出结构化结果。可以直接抄 `packages/bundle/headless/src/index.ts`。

3. 用 profile manifest 把 `dsh-base` + 这个 bundle 拼起来；opencode 用
   `dsh --profile opencode --json --model deepseek-v4-flash "task"` 这类稳定 app 命令来调用。

这样你得到的是**自己拥有的、稳定的 app 参数和输出格式**，而不是依赖 `headless` 那套"文本 stdout + exit code"的脆弱约定。

## 但要清醒：plugin 也有边界

有几点 plugin 解决不了，不要指望写 plugin 绕过：

- **developer preview / 破坏兼容是项目级承诺问题。** 你可以用 plugin 固化自己的协议，但底层 session 格式是 `SESSION_FORMAT_VERSION = 0`、无兼容承诺（`AGENTS.md`、`docs/subsystems/persistence.md`）。所以正确做法是 pin DSH 版本，并把跨版本恢复封装在你自己的 SDK 层，不要直接依赖 JSONL 布局。
- **`read-only` 不防网络是 sandbox seam 的设计边界。** plugin 可以 gate 工具、可以换 sandbox/subprocess backend，但"绝对禁网"最终还是要落到 OS/容器/网络 namespace 层。
- **launcher 级 flag（`--profile`、`--patch`）是 launcher 的，不是 app 的。** plugin 能自由设计的是 app 参数区；别去改 launcher 语法。
- **ACP 的 "fresh sessions only"** 是现有 ACP plugin 的限制，不是框架限制。如果你需要 resume，正好是自己写 protocol driver 的理由之一。

一句话总结：**这个任务非常适合用 plugin 解决，而且推荐这么干——把 opencode 集成做成一个自有 bundle + 自有 app 参数/JSON 输出，复用 ACP/headless 的现成模式；但稳定性和网络安全这两件事，不能靠 plugin 承诺，要在集成层和部署层兜底。**