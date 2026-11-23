# TrackVault v2

全新分层重构的私有自托管双平台音乐工作台（网易云音乐 + QQ 音乐）。

## 架构概览

- `packages/shared`：前后端唯一 Zod 契约、稳定错误码 `ErrorCode`、安全 URL / 文件名 / CSV 公式防注入工具。
- `packages/audio-tags`：零依赖 FLAC / MP3 二进制标签写入器（含魔数/越界保护）与统一 LRC/YRC 解析器。
- `apps/server`：Fastify 5 四层后端架构（`interfaces/http` → `application` → `domain` → `infrastructure`）：
  - 原生 Node 24 `node:sqlite` WAL 单轨存储 + 顺序 Migration；
  - `AES-256-GCM` 服务端静态加密存平台凭证，绝不向前端回传明文 Cookie；
  - 自研无状态 `QqMusicAdapter`（彻底移除 `qq-music-api` 全局单例）；
  - `SafeHttpClient`（`redirect: "manual"` + 逐跳白名单 + 私网 IP 拦截 + 流式体积上限）；
  - 统一 `BackgroundJobManager` + SSE `/api/events` 实时进度推送。
- `apps/web`：React 18 + Vite + React Router 7 + Zustand + TanStack Query + Tailwind CSS v4：
  - 独立于 React 的 `AudioEngine` + 高低频双分片 Store，播放期主树 0 重渲染；
  - SSE 驱动进度，零后台轮询风暴。

## 快速开始（需要 Node 24+）

```bash
cd v2
npm install
npm run dev
```

- 后端默认监听 `http://127.0.0.1:3010`
- 前端开发服务器监听 `http://127.0.0.1:5173`
- 首次打开页面将引导创建管理员账号。

## 常用脚本

```bash
npm run lint        # Biome 代码检查
npm run typecheck   # 全仓严格 TypeScript 类型检查
npm run test        # 运行 shared / audio-tags / server / web 全套测试
npm run build       # 构建全部包、后端与前端生产包
npm start           # 生产模式启动（托管构建好的前端）
```

## Docker 自托管

```bash
cd v2/docker
docker compose up -d --build
```
