#!/usr/bin/env bash
#
# install.sh — 把 deepseek_delegate opencode 自定义工具安装到目标项目。
#
# 两种模式:
#   wrapper    在目标项目放一个薄壳 .opencode/tools/deepseek_delegate.ts,
#              再导出 hub(本仓库)的完整安装。秒装、零依赖复制,
#              但目标项目依赖 hub 路径持续存在;任务状态/审计落在 hub。
#   standalone 把运行所需文件完整复制到目标项目并独立 bun install,
#              目标项目自带全部代码与依赖,与 hub 再无关系。
#
# 用法:
#   ./install.sh                          # 交互式(询问安装目录与模式)
#   ./install.sh -t <dir> -m <mode> -y    # 非交互(供 agent/CI 调用)
#
set -uo pipefail

# ---------------------------------------------------------------- 基础设置 --
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
NONINTERACTIVE=false
TARGET=""
MODE=""

info()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[warning]\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
die()   { printf '\033[1;31m[error]\033[0m 第 %s 行命令失败(退出码 %s)\n' "$1" "$2" >&2; exit 1; }
trap 'die "$LINENO" "$?"' ERR

usage() {
  cat <<EOF
用法: install.sh [-t 安装目录] [-m wrapper|standalone] [-y] [-h]
  -t  目标 opencode 项目目录(不存在则创建;需可写)
  -m  安装模式(缺省交互式询问)
  -y  非交互模式(配合 -t -m 使用)
  -h  显示帮助
EOF
}

# ---------------------------------------------------------------- 参数解析 --
while [ "$#" -gt 0 ]; do
  case "$1" in
    -t) [ "$#" -ge 2 ] || { usage; fail "-t 缺少目录参数"; }; TARGET="$2"; shift 2 ;;
    -m) [ "$#" -ge 2 ] || { usage; fail "-m 缺少模式参数"; }; MODE="$2"; shift 2 ;;
    -y) NONINTERACTIVE=true; shift ;;
    -h) usage; exit 0 ;;
    *)  usage; fail "未知参数: $1" ;;
  esac
done

# ------------------------------------------------------------ 前置条件检查 --
command -v bun >/dev/null 2>&1 || fail "找不到 bun。请先安装: https://bun.sh"

for req in src/delegate-execute.ts scripts/delegate-runner.ts \
           .opencode/tools/deepseek_delegate.ts dsh/cordis/base.cordis.yml \
           package.json bun.lock; do
  [ -f "$SCRIPT_DIR/$req" ] || fail "hub 安装不完整: 缺少 $req(请在 deepseek-delegate 仓库根目录运行本脚本)"
done

ask() { # ask <var-name> <prompt>
  local __prompt="$2" __answer=""
  while :; do
    printf '%s ' "$__prompt" >&2
    IFS= read -r __answer || return 1
    [ -n "$__answer" ] && break
    warn "输入不能为空"
  done
  printf -v "$1" '%s' "$__answer"
}

if [ -z "$TARGET" ]; then
  [ -t 0 ] || fail "非交互环境请用 -t 指定安装目录(或用 -h 查看用法)"
  ask TARGET "安装到哪个目录?(opencode 项目根,不存在则创建)"
fi
case "$TARGET" in "~"*) TARGET="${HOME}${TARGET#\~}" ;; esac
[ -d "$TARGET" ] || mkdir -p "$TARGET" || fail "无法创建目录: $TARGET"
TARGET="$(cd -- "$TARGET" >/dev/null 2>&1 && pwd)" || fail "无法进入目录: $TARGET"
[ -w "$TARGET" ] || fail "目标目录不可写: $TARGET"
[ "$TARGET" != "$SCRIPT_DIR" ] && [ "${TARGET#"$SCRIPT_DIR"/}" = "$TARGET" ] \
  || fail "目标目录就是 hub 仓库自身或其子目录,拒绝安装"

if [ -z "$MODE" ]; then
  if [ "$NONINTERACTIVE" = true ] || [ ! -t 0 ]; then
    MODE="wrapper"
    info "未指定模式,默认使用 wrapper"
  else
    printf '%s ' "安装模式: [1] wrapper 薄壳(推荐,秒装,依赖 hub 存续) / [2] standalone 独立完整安装" >&2
    read -r MODE || { MODE="wrapper"; warn "读取失败,默认 wrapper"; }
    case "$MODE" in 2|standalone) MODE="standalone" ;; *|1|wrapper) MODE="wrapper" ;; esac
  fi
fi
case "$MODE" in wrapper|standalone) : ;; *) fail "未知模式: $MODE(可选 wrapper | standalone)" ;; esac

info "hub:  $SCRIPT_DIR"
info "目标: $TARGET"
info "模式: $MODE"

back_up() { # back_up <file> — 存在则加时间戳备份
  local f="$1"
  if [ -e "$f" ]; then
    cp -p "$f" "$f.bak.$TIMESTAMP" && rm -rf "$f"
    warn "已备份旧文件 -> $f.bak.$TIMESTAMP"
  fi
}

verify_import() { # verify_import — 在目标目录验证工具可加载,失败即 fail
  local tmp out
  tmp="$(mktemp "${TMPDIR:-/tmp}/dsd-verify.XXXXXX")" || fail "无法创建临时验证文件"
  mv "$tmp" "$tmp.ts" || fail "无法重命名临时验证文件"
  tmp="$tmp.ts"
  cat >"$tmp" <<TS
const m = await import('$TARGET/.opencode/tools/deepseek_delegate.ts')
const ok = m.default && typeof m.default.execute === 'function' && m.output && m.cancel
if (!ok) { console.error('exports missing'); process.exit(1) }
console.log('tool id: deepseek_delegate (+ _output / _cancel)')
TS
  if ! out="$( (cd "$TARGET" && bun "$tmp") 2>&1 )"; then
    rm -f "$tmp"
    fail "安装后验证失败:\n$out"
  fi
  rm -f "$tmp"
  info "加载验证通过: $out"
}

# ------------------------------------------------------------ wrapper 模式 --
install_wrapper() {
  local dest="$TARGET/.opencode/tools/deepseek_delegate.ts"
  mkdir -p "$TARGET/.opencode/tools" || fail "无法创建 $TARGET/.opencode/tools"
  if [ -e "$dest" ] && [ "$NONINTERACTIVE" != true ]; then
    warn "目标已存在同名工具文件: $dest"
    printf '%s ' "覆盖?(旧文件自动备份)[y/N] " >&2
    local ans=""; read -r ans || ans="n"
    case "$ans" in [yY]*) : ;; *) fail "用户取消安装" ;; esac
  fi
  back_up "$dest"
  cat >"$dest" <<EOF
/**
 * deepseek_delegate 薄壳安装(wrapper 模式)。
 * 全部实现与依赖位于 hub: $SCRIPT_DIR
 * 删除/移动 hub 会使本项目的委派工具失效;届时请重装或改用 standalone 模式。
 */
export { default, output, cancel } from '$SCRIPT_DIR/.opencode/tools/deepseek_delegate.ts'
EOF
  [ -f "$dest" ] || fail "wrapper 文件写入失败"
  info "wrapper 已安装: $dest"
}

# --------------------------------------------------------- standalone 模式 --
install_standalone() {
  local items=(src scripts dsh docs tests README.md package.json bun.lock tsconfig.json .gitignore)
  local i
  for i in "${items[@]}"; do
    [ -e "$SCRIPT_DIR/$i" ] || fail "hub 缺少待复制项: $i"
  done

  # 目标已有 .opencode / node_modules 时先备份,避免混入陈旧依赖
  back_up "$TARGET/.opencode"
  back_up "$TARGET/node_modules"
  mkdir -p "$TARGET/.opencode" || fail "无法创建 $TARGET/.opencode"

  for i in "${items[@]}"; do
    cp -R "$SCRIPT_DIR/$i" "$TARGET/" || fail "复制 $i 失败"
  done

  # .opencode 依赖边界:只分发声明/锁/工具源码,不搬运 hub 的 node_modules。
  # 必须在 bun install 之前全部落盘,并在之后复检,防止被安装流程清掉。
  mkdir -p "$TARGET/.opencode/tools" || fail "无法创建 $TARGET/.opencode/tools"
  [ -f "$SCRIPT_DIR/.opencode/tools/deepseek_delegate.ts" ] \
    || fail "hub 缺少 .opencode/tools/deepseek_delegate.ts"
  cp "$SCRIPT_DIR/.opencode/tools/.gitkeep" "$TARGET/.opencode/tools/" 2>/dev/null || true
  cp "$SCRIPT_DIR/.opencode/tools/deepseek_delegate.ts" "$TARGET/.opencode/tools/" \
    || fail "复制工具入口失败"
  cp "$SCRIPT_DIR/.opencode/package.json" "$TARGET/.opencode/" 2>/dev/null \
    || warn ".opencode/package.json 不存在,跳过(opencode 会回退到根 node_modules 解析)"
  cp "$SCRIPT_DIR/.opencode/bun.lock" "$TARGET/.opencode/" 2>/dev/null || true
  info "代码文件已复制"

  info "安装依赖(独立安装,约需几十秒)…"
  if ! (cd "$TARGET" && bun install); then
    fail "目标项目 bun install 失败。请进入 $TARGET 手动重试并检查网络/npm 源"
  fi
  [ -f "$TARGET/.opencode/tools/deepseek_delegate.ts" ] \
    || fail "bun install 清掉了工具入口(不应发生):$TARGET/.opencode/tools/deepseek_delegate.ts 缺失"
  # bun pm trust 退出码 1 可能仅表示"已信任/无脚本可跑",以实际效果为准:
  # 按当前 CPU 架构精确验证 node-pty spawn-helper 可执行位(生命周期脚本的核心产物)。
  (cd "$TARGET" && bun pm trust @deepseek-ai/dsh-subprocess-local koffi) >/dev/null 2>&1 || true
  local helper arch
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  arch="darwin-arm64" ;;
    Darwin-x86_64) arch="darwin-x64" ;;
    Linux-x86_64)  arch="linux-x64" ;;
    Linux-aarch64) arch="linux-arm64" ;;
    *)             arch="" ;;
  esac
  if [ -n "$arch" ] && [ -f "$TARGET/node_modules/node-pty/prebuilds/$arch/spawn-helper" ]; then
    helper="$TARGET/node_modules/node-pty/prebuilds/$arch/spawn-helper"
    if [ -x "$helper" ]; then
      info "生命周期脚本已生效($arch spawn-helper 可执行)"
    else
      chmod +x "$helper" && info "已自动补上 $arch spawn-helper 可执行位"
    fi
  else
    info "未命中已知 node-pty 预编译布局,跳过信任位检查"
  fi
}

# ------------------------------------------------------------------ 执行 --
case "$MODE" in
  wrapper)    install_wrapper ;;
  standalone) install_standalone ;;
esac

verify_import

command -v rg >/dev/null 2>&1 && ! grep -q DEEPSEEK_API_KEY ~/.zshrc 2>/dev/null \
  && warn "shell 配置里未见 DEEPSEEK_API_KEY —— 运行 opencode 前请确保已 export(工具必需)"

echo ""
info "安装完成。在目标项目运行 opencode 即可使用 deepseek_delegate。"
echo "  - explore/vision 只读分析、write 限额写入、unrestricted 需逐次确认 token"
echo "  - 用法示例见 README:'### explore: one synchronous analysis' 起"
[ "$MODE" = "wrapper" ] && echo "  - wrapper 模式:任务状态与审计记录统一存于 hub 的 .omo/deepseek-delegate/"
exit 0
