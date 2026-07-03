# TrackVault

TrackVault 是一个面向个人自用和小范围朋友使用的音乐工作台。它把搜索、播放、歌单管理、评论、账号状态、下载和歌单互转放在同一个桌面 Web 界面里，核心接入网易云音乐，并保留 QQ 音乐的实验性接入能力。

这个项目不是公共音乐站点，也不是单纯的下载器。它更像一个“本地音乐客户端 + 下载管理 + 歌单工具”的组合：登录自己的账号，查看自己的内容，在账号权限允许的范围内播放、整理和保存音乐文件。

## 当前状态

项目仍处于个人迭代阶段，功能已经能覆盖日常使用，但代码还保留了不少快速开发留下的历史包袱。当前优先级是继续打磨交互、补齐刚需功能和稳定下载链路；结构性重构会放在功能基本稳定之后再做。

## 核心能力

### 音乐浏览与播放

- 发现音乐、每日推荐、私人雷达、私人漫游。
- 歌曲搜索、歌手页、专辑页、我的歌单、云盘音乐。
- 播放队列、随机播放、播放历史、搜索历史。
- 全屏播放器、歌词滚动、缓冲进度、音质切换。
- 未登录时锁定播放与下载，避免无声播放或无效操作。

### 歌单管理

- 查看自己创建和收藏的歌单。
- 歌单内搜索歌曲。
- 歌单歌曲多选、删除、自定义排序。
- 收藏到我的歌单，支持单曲和批量收藏。
- 收藏时会排除歌曲当前所在歌单，减少重复操作。

### 评论与用户信息

- 歌曲评论区。
- 评论点赞、回复、查看折叠回复。
- 点击头像查看用户资料。
- 查看用户歌单、动态、关注和粉丝等信息。

### 下载

TrackVault 目前提供三种下载方式：

| 方案 | 说明 | 适合场景 |
| --- | --- | --- |
| 方案A：直连下载并写入标签 | 浏览器直读 CDN 音频流，并写入封面、歌手、专辑和歌词 | 追求文件信息完整，且浏览器未被跨域限制 |
| 方案B：裸直链下载 | 浏览器直读 CDN 音频流，按项目文件名保存，不写入元数据 | 想尽量节省服务器带宽，只需要原始音频 |
| 方案C：服务器备用下载 | 服务器拉取音频、写入元数据，再传给浏览器 | 直连失败、跨域受限、需要更稳定的保存结果 |

已支持的下载细节：

- MP3 写入 ID3v2.3 标签。
- FLAC / Hi-Res FLAC 写入 Vorbis Comment 和封面块。
- 标签内容包括标题、歌手、专辑、封面和歌词。
- 封面会尽量使用高清图。
- 备用下载显示当前速度和文件大小。
- 下载文件名使用 `歌名 - 歌手.ext`，避免 CDN 对象名或歌曲 ID 混入文件名。
- 浏览器下载任务会记录来源：直连标签、裸直链、本机备用。

### 双平台与歌单互转

网易云是当前主线能力。QQ 音乐已经接入部分账号、搜索、歌单和音源能力，但仍属于实验阶段。

已包含的跨平台工具：

- 文本歌单解析。
- 网易云导入审计。
- 歌单匹配和差异比较。
- 网易云和 QQ 音乐之间的歌单对比基础能力。
- 导出匹配结果和缺失结果。

未来目标是登录网易云和 QQ 音乐两个账号后，按账号权限、版权情况和音源质量选择更合适的来源。但这部分还没有完全做成稳定的双平台聚合客户端。

## 登录方式

网易云音乐：

- 二维码登录。
- 手机号验证码登录。
- Cookie 登录态导入。

QQ 音乐：

- Cookie 登录态导入。
- 账号状态检测。

项目支持会话隔离。不同浏览器、不同设备或无痕窗口可以保存各自的登录状态，便于自己和朋友分别使用。

## 技术栈

- 前端：React 18、TypeScript、Vite
- 后端：Express、TypeScript
- 网易云接口：`NeteaseCloudMusicApi`
- QQ 音乐接口：`qq-music-api`
- 运行时存储：
  - 优先使用 `node:sqlite`
  - 不支持时回退到 `data/app-store.json`

## 本地开发

### 安装依赖

```bash
npm install
```

### 启动开发环境

```bash
npm run dev
```

默认端口：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3010`

如果项目位于 Windows 网络共享路径，例如 `\\server\share\...`，`cmd.exe` 可能无法把 UNC 路径作为工作目录。建议把项目放在本地盘符，或先用 `pushd \\server\share\project` 映射临时盘符后再运行命令。

### 构建

```bash
npm run build
```

### 运行生产构建

```bash
npm run start
```

### 测试

```bash
npm test
```

## 目录结构

```text
TrackVault/
├─ src/                      前端 React 应用
│  ├─ App.tsx                主界面、播放器、弹窗和交互状态
│  ├─ api.ts                 前端 API 封装和浏览器下载逻辑
│  ├─ styles.css             全局样式
│  ├─ types.ts               前端类型定义
│  └─ main.tsx               应用入口
├─ server/                   后端接口与业务层
│  ├─ index.ts               Express 入口与 API 路由
│  ├─ provider.ts            网易云搜索与基础歌曲映射
│  ├─ qqmusic-provider.ts    QQ 音乐实验性接入
│  ├─ task-store.ts          下载任务、音源解析和文件保存
│  ├─ download-metadata.ts   下载元数据写入调度
│  ├─ flac-metadata.ts       FLAC 标签写入
│  ├─ mp3-metadata.ts        MP3 ID3 标签写入
│  ├─ playlist-provider.ts   歌单读取、搜索、排序和维护
│  ├─ comment-provider.ts    评论、点赞和回复
│  ├─ user-provider.ts       用户资料、动态和社交信息
│  ├─ account-store.ts       登录会话和账号状态
│  ├─ settings-store.ts      设置存储
│  ├─ database.ts            SQLite / JSON 回退存储适配层
│  └─ playlist-transfer/     歌单互转、匹配和审计
├─ data/                     运行时数据目录，自动生成
├─ dist/                     前端构建产物
├─ dist-server/              后端构建产物
└─ docs/                     详细文档和功能说明
```

## 运行时数据

项目运行后会自动生成 `data/` 目录。根据运行环境不同，数据会保存到：

- SQLite：`data/app.db`
- JSON 回退：`data/app-store.json`

持久化内容包括：

- 登录会话
- 设置
- 搜索历史
- 播放历史
- 播放器状态
- 下载任务
- 歌单互转任务

## 部署说明

项目可以用 `systemd` 常驻运行。典型形式：

```text
WorkingDirectory=/opt/TrackVault
ExecStart=node /opt/TrackVault/dist-server/index.js
```

部署时通常只需要上传：

- `dist/`
- `dist-server/`
- `package.json`
- `package-lock.json`

然后在服务器上执行：

```bash
npm install --omit=dev
systemctl restart trackvault.service
```

## 已知限制

- 网易云和 QQ 音乐接口都不是稳定的公开业务 API，接口返回可能随时变化。
- 部分音源依赖账号权限、版权状态和平台限制，项目不会保证所有歌曲都可播放或可下载。
- 方案 A 和方案 B 都依赖浏览器能读取 CDN 音频流；被跨域策略拦截时需要使用方案 C。
- QQ 音乐接入仍在打磨，暂时不等同于完整 QQ 音乐客户端。
- 当前代码仍偏快速迭代形态，后续需要按模块拆分播放、下载、歌单和平台适配层。

## 文档

更详细的项目说明见：

- [docs/PROJECT_DOCUMENTATION.md](docs/PROJECT_DOCUMENTATION.md)
- [docs/PLAYLIST_TRANSFER_FEATURE_REQUIREMENTS.md](docs/PLAYLIST_TRANSFER_FEATURE_REQUIREMENTS.md)

## 使用边界

TrackVault 面向个人学习、研究和自用场景。请在符合相关服务条款、账号权限和当地法律法规的前提下使用。不要把服务器密码、Cookie、登录态或管理员凭证提交到仓库。
