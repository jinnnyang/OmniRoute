# Runner CLI Note — 4 个预装 AI CLI 的取舍记录

> 状态：**决策已落地（3.8.56）** · 初始记录 2026-09-25，落地 2026-09-26
> 类型：先记录后决策；3.8.56 起 **移除 4 个预装 AI CLI**

## 观察（2026-09-25 基线）

Docker 镜像（`jinnnyang/omniroute:3.8.55`，约 7.3GB）的 runner-cli 层（约 **1.81GB**）全局预装了 4 个 AI 代理 CLI：

| CLI         | 包                          | 用途                                                                |
| ----------- | --------------------------- | ------------------------------------------------------------------- |
| codex       | `@openai/codex`             | OpenAI 终端 AI 编码 agent                                           |
| claude-code | `@anthropic-ai/claude-code` | Anthropic 终端编码 agent                                            |
| droid       | `droid`                     | 开源终端 AI 代理 CLI                                                |
| openclaw    | `openclaw@latest`           | 消息应用 AI 助手（WhatsApp/Telegram/Slack/Discord/iMessage/Signal） |

- 安装点：`Dockerfile`（`npm install -g --no-audit --no-fund @openai/codex @anthropic-ai/claude-code droid openclaw@latest`，**未锁版本**）
- 设计意图：容器开箱即用，CLI 直接指向本机 OmniRoute（`OPENAI_BASE_URL=http://localhost:20128`）

## 3.8.55 → 3.8.56 体积暴涨根因

Dockerfile 在两个 tag 间**完全没改**；暴涨来自未锁 `@latest` 的全局包漂移（runner-cli 层）：

| CLI         | 3.8.54 时的包                 | 3.8.55 时的包                      | 增量   |
| ----------- | ----------------------------- | ---------------------------------- | ------ |
| openclaw    | 2026.9.2（524MB）             | 2026.9.6（648MB）                  | +124MB |
| droid       | 0.213.0（216KB 薄壳 wrapper） | 0.226.2（486MB，附完整原生二进制） | +486MB |
| codex       | 0.153.4（40KB wrapper）       | 0.156.1（370MB）                   | +370MB |
| claude-code | 2.1.263（52KB wrapper）       | 2.1.281（227MB）                   | +227MB |

54 时后三包只是几十 KB 的 wrapper；两周内 `@latest` 漂移到附完整二进制的版本，**内容净增约 530MB**，磁盘层再叠加 chown 与 base 层差异。

## 决策（3.8.56，2026-09-26）

1. **移除 4 个 CLI**（`npm install -g` 层整体删除），不再做版本锁定——用户确认"基本都用不到"。
2. runner-cli 阶段保留（dev `cli` profile / `podman-machine-guidance-8497.test.ts` 仍引用 `target: runner-cli`），但只含 `git ca-certificates docker-cli docker-compose`（apt 不再装 `docker.io` 引擎，省 300MB+）。
3. `docker-compose.prod.yml` 的 `omniroute-prod` 构建目标切到 `runner-base`（生产不用预装 CLI/容器内 docker，与已发布镜像对齐）。
4. `codex-app-server` compose sidecar 移除：它依赖镜像内 codex CLI，镜像不再提供；provider 本身保留（外部自跑 app-server + `OMNIROUTE_CODEX_APPSERVER_WS`）。
5. standalone 剪裁 + `COPY --chown` 替代 `RUN chown`（见下）。

## 3.8.56 体积构成（构建后核对）

- runner-base：目标 ~520MB 内容（3.8.55 基线 1.67GB）
- runner-cli：仅比 base 多 docker CLI/compose/git（~20-40MB）
- standalone 剪裁：`.nft.json` ×805（618.8MB）+ 冗余 `.next/static`（48.8MB）+ tests/playwright-report/electron/images（~31MB）全部移除

## 引用面核查（保留项）

- `src/lib/skills/sandbox.ts`：`docker kill` → runner-cli 保留 docker CLI（连宿主 daemon）
- `src/lib/system/autoUpdate.ts`：`docker compose|docker-compose` → apt `docker-compose`（v2）满足
- `docs/`（109.9MB）：Docs viewer 运行时读取，**保留**

## 证据

- `docker history`（3.8.55）：runner-cli 层 1.81GB、runtime apt 413MB、standalone 复制 1.51GB + chown 1.52GB
- 镜像体积历史：3.8.51=4.36GB / 3.8.53=7.13GB / 3.8.54=5.5GB / 3.8.55=7.3GB（磁盘），内容 903MB / 1.58GB / 1.14GB / 1.67GB
- npm registry（2026-09-25 核对）：openclaw 2026.9.6/311MB、claude-code 2.1.283/184MB、droid 0.227.0/26MB、codex 0.157.1/13MB
