# OmniRoute Build Troubleshooting

> 构建/发布过程中**可复现**问题的 post-mortem 记录（症状 → 根因 → 修复 → 验证）。
> 机器特定的一次性环境问题（DNS 污染、代理节点不稳等）不记在这里，见代理/环境备注。
> 新增条目：优先判断"换台机器/重跑 CI 是否会再遇到"——是才记。

## 2026-09-24 · v3.8.55 Docker 构建

### 1. `npm ci` EUSAGE: Missing: brace-expansion@… from lock file

- **症状**：Dockerfile 内 `npm ci` 报 `EUSAGE, Missing: brace-expansion@1.1.21 from lock file`；本地 `npm install --package-lock-only` 却报 up to date、无 diff。
- **根因**：package-lock.json 与 package.json 依赖解析不同步。容器内 npm 版本（node:26-trixie-slim + npm@latest ≈ 13.x）按 overrides 解析出更高版本（如 brace-expansion@1.1.21），lock 里固定的是旧版本（1.1.18）；本地 npm@10 对同一 lock 判定同步。`npm ci` 做严格校验、`npm install` 不做。
- **修复**：用**容器同款 npm** 重生成 lock：
  `docker run --rm -v ${PWD}:/app -w /app node:26-trixie-slim sh -c "npm install -g npm@latest && npm install --package-lock-only --ignore-scripts --legacy-peer-deps --no-audit --no-fund"`
  （必须 `--ignore-scripts`，否则 prepare/husky 脚本在容器内失败）
- **验证**：容器内 `npm ci --dry-run --include=optional --ignore-scripts --legacy-peer-deps` 通过；重新 `docker build` 过 npm ci 层。
- **规避**：不要用脚本/文本替换手改 lock；lock 变更一律用 npm 重生成。发布前在**构建同版本 npm** 下验证 `npm ci --dry-run`。

### 2. `npm ci` EALLOWREMOTE: Refusing to fetch "@playwright/test@https://registry.npmmirror.com/…"

- **症状**：npm@13 报 `EALLOWREMOTE, Fetching packages of type "remote" have been disabled`，指向 lock 里某个包 resolved 为第三方 registry（npmmirror）tarball。
- **根因**：lock 中该条目 resolved 被本地换源（npmmirror）写入；npm@13 默认禁止 lock 中的 remote tarball（跨 registry 引用）。
- **修复**：把该条目的 `resolved` 改回 `https://registry.npmjs.org/<scope>/<name>/-/<file>.tgz`（仅 host 变化，integrity 不变）。只改一处、单行 diff。
- **验证**：`docker build` 的 npm ci 层通过。
- **规避**：**不要**把本地 registry 源写进 lock；lock 里 resolved 一律保持 registry.npmjs.org。

### 3. Docker Desktop（新版 SettingsVersion 45）配置位置

- **症状**：改 `~/.docker/daemon.json` 加 `max-concurrent-uploads: 1` 不生效；proxy 配置在 `%APPDATA%\Docker\settings.json` 找不到。
- **根因**：新版 Docker Desktop 的宿主 daemon 配置在 **`%USERPROFILE%\.docker\windows-daemon.json`**；应用设置（含代理）在 **`%APPDATA%\Docker\settings-store.json`**（字段 `ProxyHTTPMode` / `OverrideProxyHTTP` / `OverrideProxyHTTPS` / `OverrideProxyExclude`）。旧 `settings.json` / `~/.docker/daemon.json` 路径已不用。
- **修复**：改对应文件后**完全重启**（杀 Docker Desktop 进程 + `wsl --terminate docker-desktop` 停 daemon distro 再启动；仅重启 GUI 进程 daemon 不重载）。
- **验证**：`docker pull` 走代理成功（小镜像）；push 显示串行上传（无多层并行 Waiting）。
- **注意**：代理配置会被 Docker Desktop 尝试镜像到 WSL 集成 distro，NAT 模式 WSL 不支持 localhost 代理 → WSL 集成弹窗报错；不影响 daemon 本身，可忽略或关代理后重启 WSL 集成。

### 4. 镜像体积构成（认知基线）

- 见 [`docs/runner-cli-note.md`](runner-cli-note.md)：7.3GB ≈ runner-cli 层 1.81GB（4 个 AI CLI）+ standalone/chown ~3GB + runtime apt 413MB（内嵌 docker.io）+ base ~275MB。体积历史：3.8.51=4.36GB / 3.8.53=7.13GB / 3.8.54=5.5GB / 3.8.55=7.3GB。

## 历史备注（本机环境，不入主表）

- 本机到 Docker Hub 的 DNS 解析被投毒（registry-1.docker.io → Meta 网段假 IP），docker pull/push 需经 `127.0.0.1:7897`（Clash）代理；Clash 节点对 Docker Hub 大文件上传不稳定（broken pipe / 连接被掐），`max-concurrent-uploads: 1` 串行上传可降低断连概率。
