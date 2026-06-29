# TrackVault

TrackVault 是一个面向个人自用的本地音乐工作台，围绕“搜索、试听、播放、下载、歌单管理、会话隔离登录”构建，前端采用 React + Vite，后端采用 Express，并通过 [NeteaseCloudMusicApi](https://binaryify.github.io/NeteaseCloudMusicApi/#/) 接入网易云音乐能力。

它不是一个“纯下载器”，而是一套偏工作台形态的本地音乐管理界面：

- 搜索歌曲、歌手、专辑
- 试听、播放、随机播放
- 多选歌曲、批量下载并跟踪任务状态
- 浏览发现音乐、每日推荐、我的歌单、云盘音乐
- 查看歌手页、专辑页、歌词
- 支持二维码登录和手机号验证码登录
- 支持多浏览器会话隔离，便于多人测试

## 核心特性

- 网易云搜索、发现音乐、每日推荐、歌单、云盘
- 歌曲试听与完整播放器状态持久化
- 歌词读取、滚动定位、全屏沉浸式播放器
- 下载队列、失败自动重试、任务持久化
- 多选歌曲、批量下载、批量加入队列入口
- 喜欢歌曲状态同步
- 歌手页、专辑页跳转
- 搜索历史、播放历史持久化
- 会话级登录隔离，不同设备/无痕窗口互不串号
- 媒体访问 ACL、白名单特权回退、管理员全局保底凭证
- 本地数据库优先，旧 Node 运行时自动回退 JSON 存储

## 技术栈

- 前端：React 18、TypeScript、Vite
- 后端：Express、TypeScript
- 音乐接口：`NeteaseCloudMusicApi`
- 存储：
  - 优先：`node:sqlite`（Node 22+）
  - 回退：`data/app-store.json`（Node 20 等不支持 `node:sqlite` 的环境）

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发环境

```bash
npm run dev
```

默认端口：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3010`

如果项目位于 Windows 网络共享路径（例如 `\\server\share\...`），直接执行 `npm run dev` 可能因为 `cmd.exe` 不支持 UNC 工作目录而导致只起后端或前端不启动。此时建议：

- 将项目放到本地盘符目录后再开发
- 或先通过 `pushd \\server\share\project` 映射临时盘符后再执行 `npm run dev`

### 3. 生产构建

```bash
npm run build
```

### 4. 本地生产启动

```bash
npm run start
```

## 目录结构

```text
TrackVault/
├─ src/                      前端 React 应用
│  ├─ App.tsx                主页面、播放器、路由态、业务交互
│  ├─ api.ts                 前端 API 封装
│  ├─ styles.css             全局样式
│  ├─ types.ts               前端类型定义
│  └─ main.tsx               应用入口
├─ server/                   后端接口与业务层
│  ├─ index.ts               Express 入口与 API 路由
│  ├─ provider.ts            搜索 provider
│  ├─ discover-provider.ts   发现音乐
│  ├─ recommend-provider.ts  每日推荐
│  ├─ playlist-provider.ts   歌单与分页
│  ├─ cloud-provider.ts      网易云盘
│  ├─ artist-provider.ts     歌手页
│  ├─ album-provider.ts      专辑页
│  ├─ lyric-provider.ts      歌词读取与兜底
│  ├─ task-store.ts          下载任务、自动重试、流地址解析
│  ├─ settings-store.ts      设置存储
│  ├─ history-store.ts       搜索/播放历史
│  ├─ player-state-store.ts  播放器状态
│  ├─ account-store.ts       本地账号与会话状态
│  ├─ netease-auth.ts        网易云扫码/验证码登录
│  ├─ song-like-provider.ts  喜欢歌曲
│  ├─ request-context.ts     会话隔离上下文
│  ├─ database.ts            SQLite / JSON 回退存储适配层
│  └─ types.ts               后端类型定义
├─ data/                     运行时数据目录（自动生成）
├─ dist/                     前端构建产物
├─ dist-server/              后端构建产物
└─ docs/                     详细文档
```

## 详细文档

完整项目文档见：

- [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md)
- [docs/MULTI_PLATFORM_ARCHITECTURE.md](docs/MULTI_PLATFORM_ARCHITECTURE.md)

内容包括：

- 业务能力说明
- 页面与交互结构
- 后端 API 清单
- 数据持久化与会话隔离
- 媒体 ACL 与管理员白名单回退
- 多平台改造路线与 QQ 接入演进方案
- 下载、播放、登录等核心链路
- 部署方式与运维建议
- 已知限制与后续扩展方向

## 运行时数据

项目运行后会自动生成 `data/` 目录。

根据运行环境不同，数据会落到：

- SQLite：`data/app.db`
- JSON 回退：`data/app-store.json`

持久化内容包括：

- 搜索历史
- 播放历史
- 播放器状态
- 设置
- 下载任务

## 当前部署方式

当前服务端可使用 `systemd` 常驻，典型形式如下：

- 工作目录：`/opt/TrackVault`
- 服务名：`trackvault.service`
- 启动命令：`node /opt/TrackVault/dist-server/index.js`

注意：不要把服务器密码、Cookie 或登录态信息写入文档或提交仓库。

## 说明

TrackVault 当前定位是“个人本地音乐工作台”，并非公共音乐站点，也不以分发平台资源为目标。请在符合相关服务条款和当地法律法规的前提下自用。
