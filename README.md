# TrackVault v2

私有自托管双平台音乐工作台（网易云音乐 + QQ 音乐），采用 npm workspaces 单体仓库与严格分层架构。

## 架构概览

- `packages/shared`：前后端唯一 Zod 契约、稳定错误码 `ErrorCode`、安全 URL 校验、文件名清洗与 CSV 公式防注入工具。
- `packages/audio-tags`：零依赖 FLAC / MP3 二进制流式标签写入器（含魔数与越界保护）及统一 LRC / YRC 逐字歌词解析器。
- `apps/server`：Fastify 5 六边形架构后端（`interfaces/http` → `application` → `domain` → `infrastructure`）：
  - 原生 Node 24 `node:sqlite` 持久化（默认 `WAL` 模式，支持 `SQLITE_JOURNAL_MODE=TRUNCATE|DELETE` 网络盘回退）与顺序 Migration；
  - `AES-256-GCM` `CredentialVault` 服务端静态加密存储平台凭证 + 单次查询 `ProviderAuthResolver`，绝不向前端回传明文 Cookie；
  - 自研无状态 `QqMusicAdapter` 与模块化 `NeteaseAdapter`（基于 `AsyncLocalStorage` 透传 Axios `AbortSignal` 请求取消与连接池复用）；
  - `SafeHttpClient`（`redirect: "manual"` 逐跳白名单校验、私网/回环 IP 拦截、流式响应体积上限）；
  - 基于单调递增 `serverRevision` 的 SSE `/api/events` 后台任务与播放历史增量同步，以及下载流式音频标签（封面/歌词/元数据）注入。
- `apps/web`：React 18 + Vite 6 + React Router 7 + Zustand + TanStack Query + Tailwind CSS v4：
  - 严格 Feature-Sliced Design（FSD）分层（`app` / `pages` / `widgets` / `features` / `entities` / `shared`，由自动化边界测试守卫）；
  - 路由级 `React.lazy` 按需代码分割与虚拟滚动 `<SongTable>` 大歌单渲染；
  - 独立于 React 的 `AudioEngine` + 解耦 4Hz 播放时钟（高低频 Store 分片，播放期主组件树零重渲染）。
- `e2e`：Playwright 浏览器端到端回归测试套件（详见 [`e2e/README.md`](./e2e/README.md)）。

## 快速开始（需要 Node 24+）

```bash
cd v2
cp .env.example .env
npm install
npm run dev
```

- 后端默认监听 `http://127.0.0.1:3010`
- 前端开发服务器监听 `http://127.0.0.1:5173`
- 首次访问页面将引导初始化管理员账号。

> **SMB / UNC / NFS 网络共享盘注意事项**
> 若代码仓库位于网络挂载路径（如 `\\server\share`、映射网络驱动器或 NFS），**强烈建议**在 `.env` 中将 `DATA_DIR` 指向本机 SSD 路径（例如 `DATA_DIR=C:/TrackVaultData` 或 `/var/lib/trackvault`），以避免 SQLite `WAL` 共享内存（`-shm`）在网络文件系统上的锁异常与延迟。若 `DATA_DIR` 必须驻留在 SMB/NFS 网络盘上，请设置 `SQLITE_JOURNAL_MODE=TRUNCATE`。完整配置项说明见 [`.env.example`](./.env.example)。

## 常用脚本

在 `v2/` 目录下执行：

```bash
npm run dev           # 构建共享包并并发启动共享包监听、后端热重载与前端 Vite 开发服
npm run dev:server    # 构建共享包并单独启动后端开发服务器（tsx watch）
npm run dev:web       # 单独启动前端 Vite 开发服务器
npm run lint          # Biome 代码规范与静态检查（npm run lint:fix 自动修复）
npm run typecheck     # 全仓严格 TypeScript 类型检查（shared / audio-tags / server / web）
npm run test          # 运行 shared / audio-tags / server / web 全套测试与架构守卫
npm run build         # 构建共享包、后端生产产物与前端静态资源
npm start             # 生产模式启动后端并托管 apps/web/dist 前端资源
npm run import:legacy # 从旧版 v1 数据目录迁移导入歌单、收藏与历史记录
```

也可按子工作区单独构建或测试：`build:packages`、`build:server`、`build:web` 与 `test:shared`、`test:audio-tags`、`test:server`、`test:web`。

运行浏览器端到端回归测试（需先执行 `npm run build:web`，详见 [`e2e/README.md`](./e2e/README.md)）：

```bash
npx playwright test --config e2e/playwright.config.mjs
```

## Docker Compose 部署

生产环境推荐通过环境变量或宿主机密钥文件显式注入 64 位十六进制主密钥 `TRACKVAULT_MASTER_KEY`，使主密钥与 `/data` 数据卷中的加密数据库分离存储：

```bash
cd v2/docker

# 生成 32 字节（64 位 hex）主密钥并注入启动
export TRACKVAULT_MASTER_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
docker compose up -d --build
```

- 容器默认仅绑定宿主机回环地址 `127.0.0.1:3010:3010`，适合置于反向代理（Caddy / Nginx / Traefik）之后；
- 通过 HTTPS 反向代理对外提供服务时，请在 [`docker/docker-compose.yml`](./docker/docker-compose.yml) 中配置实际访问域名至 `ALLOWED_ORIGINS`，并将 `COOKIE_SECURE` 设为 `"true"`、按代理层数设置 `TRUST_PROXY=1`。
