# Runner CLI Note — 4 个预装 AI CLI 的取舍记录

> 状态：**记录**（observation）· 日期：2026-09-25
> 类型：暂缓项（deferred），**非决策/ADR**——用户明确"暂不修改，先记录"

## 观察

Docker 镜像（`jinnnyang/omniroute:3.8.55`，约 7.3GB）的 runner-cli 层（约 **1.81GB**）全局预装了 4 个 AI 代理 CLI：

| CLI         | 包                          | 用途                                                                |
| ----------- | --------------------------- | ------------------------------------------------------------------- |
| codex       | `@openai/codex`             | OpenAI 终端 AI 编码 agent                                           |
| claude-code | `@anthropic-ai/claude-code` | Anthropic 终端编码 agent                                            |
| droid       | `droid`                     | 开源终端 AI 代理 CLI                                                |
| openclaw    | `openclaw@latest`           | 消息应用 AI 助手（WhatsApp/Telegram/Slack/Discord/iMessage/Signal） |

- 安装点：`Dockerfile:372`（`npm install -g --no-audit --no-fund @openai/codex @anthropic-ai/claude-code droid openclaw@latest`）
- 用途文档：`docs/guides/USER_GUIDE.md`（Docker 章节："default = runner-cli with codex/claude/droid preinstalled"；OpenClaw 章节指向 `omniroute/if/kimi-k2.7-code` 免费模型组合）
- 设计意图：容器开箱即用，CLI 直接指向本机 OmniRoute（`OPENAI_BASE_URL=http://localhost:20128`）

## 用户评估

这 4 个 CLI **基本用不到**（记录于 2026-09-25 会话，用户原话："这些基本都用不到"）。

## 决定

**暂不改**。当前发布（3.8.55）保持现状；本记录用于防止未来误判为"异常体积"或重复调查。

## 未来候选（若做，放 3.8.56+，不掺入当前发布）

1. 将 runner-cli 层拆为独立镜像/tag：`omniroute:3.8.x`（纯网关） + `omniroute:3.8.x-cli`（含 CLI）——网关镜像可减约 25%（~1.8GB）
2. runtime 内嵌 docker.io（约 300MB+）是否保留单独评估（容器内跑 Docker 的能力是否被使用）
3. 拆分前需确认：镜像消费者是否依赖镜像内 CLI（README/USER_GUIDE 的 Docker 工作流）

## 证据

- `docker history`：runner-cli 层 `1.81GB`、runtime apt `413MB`、standalone 复制 `1.51GB` + chown `1.52GB`
- 镜像体积历史：3.8.51=4.36GB / 3.8.53=7.13GB / 3.8.54=5.5GB / 3.8.55=7.3GB
