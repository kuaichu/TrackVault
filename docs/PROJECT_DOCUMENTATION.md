# TrackVault 项目文档

## 1. 项目定位

TrackVault 是一个面向个人自用的本地音乐工作台，核心目标不是做一个“漂亮壳子”，而是把下面几条链路稳定串起来：

- 网易云内容检索
- 歌曲试听与播放器控制
- 歌词、歌手、专辑等内容联动
- 下载任务入队、执行、失败重试与落盘
- 会话隔离登录与多设备测试
- 历史记录、设置、播放器状态持久化

从产品形态上看，它更接近：

- 本地音乐控制台
- 私人乐库管理器
- 带播放器的下载与内容浏览工作台

而不是单纯的“音乐下载器”。

---

## 2. 总体架构

项目采用前后端一体但职责分离的结构。

### 2.1 前端

前端使用：

- React 18
- TypeScript
- Vite

前端主要负责：

- 页面状态与伪路由切换
- 播放器 UI 和交互
- 歌曲列表、歌手页、专辑页、歌单页展示
- 多选歌曲、批量下载、批量播放队列操作
- 调用本地 Express API
- 维护当前浏览器会话的 `clientSessionId`

入口文件：

- [S:\Projects\Active\NetMusicDown\src\App.tsx](S:\Projects\Active\NetMusicDown\src\App.tsx)
- [S:\Projects\Active\NetMusicDown\src\api.ts](S:\Projects\Active\NetMusicDown\src\api.ts)
- [S:\Projects\Active\NetMusicDown\src\types.ts](S:\Projects\Active\NetMusicDown\src\types.ts)

### 2.2 后端

后端使用：

- Express
- TypeScript
- `NeteaseCloudMusicApi`

后端主要负责：

- 转发并封装网易云接口
- 做下载、歌词、歌单、歌手、专辑等业务聚合
- 管理会话隔离上下文
- 管理媒体 ACL、白名单与保底凭证回退
- 读写本地数据库 / JSON 存储
- 承担下载任务队列

入口文件：

- [S:\Projects\Active\NetMusicDown\server\index.ts](S:\Projects\Active\NetMusicDown\server\index.ts)

### 2.3 外部依赖

目前音乐能力主要依赖：

- [NeteaseCloudMusicApi](https://binaryify.github.io/NeteaseCloudMusicApi/#/)

该依赖提供：

- 搜索
- 歌单
- 云盘
- 每日推荐
- 歌词
- 歌手
- 专辑
- 喜欢歌曲
- 登录相关接口

---

## 3. 页面与功能结构

## 3.1 主要页面

当前项目主要包含以下视图：

- 发现音乐
- 搜索
- 每日推荐
- 我的歌单
- 云盘音乐
- 下载管理
- 播放历史
- 歌手页
- 专辑页
- 设置页

这些视图并未使用重量级路由框架，而是在前端通过 `navKey`、`mainTab`、`viewHistory` 等状态进行切换与返回。

## 3.2 播放器相关

播放器分为两层：

- 底部常驻播放栏
- 全屏沉浸式播放器

能力包括：

- 单击/双击播放
- 顺序播放 / 随机播放
- 进度拖动
- 音量调节
- 喜欢歌曲
- 当前播放队列
- 歌词滚动与定位

播放器状态会持久化，刷新页面后可恢复：

- 当前歌曲
- 队列
- 进度
- 音量
- 播放模式

---

## 4. 核心业务能力

## 4.1 搜索

搜索页支持：

- 关键词搜索歌曲
- 搜索历史读取与删除
- 搜索结果试听
- 搜索结果下载
- 从搜索结果跳转歌手页
- 从搜索结果跳转专辑页

主入口：

- [S:\Projects\Active\NetMusicDown\server\provider.ts](S:\Projects\Active\NetMusicDown\server\provider.ts)

接口：

- `GET /api/search?q=关键词`

## 4.2 发现音乐

发现音乐页读取推荐新歌，并带有本地缓存与后端缓存。

能力：

- 首屏推荐歌曲展示
- 播放 / 试听 / 下载
- 点击歌手进入歌手页
- 点击专辑进入专辑页

主入口：

- [S:\Projects\Active\NetMusicDown\server\discover-provider.ts](S:\Projects\Active\NetMusicDown\server\discover-provider.ts)

接口：

- `GET /api/discover/songs`

## 4.3 每日推荐

每日推荐读取网易云日推歌曲，适合登录后的个性化内容访问。

主入口：

- [S:\Projects\Active\NetMusicDown\server\recommend-provider.ts](S:\Projects\Active\NetMusicDown\server\recommend-provider.ts)

接口：

- `GET /api/recommend/daily`

## 4.4 我的歌单

歌单能力支持：

- 读取用户歌单
- 区分“我创建的”和“我收藏的”
- 分页读取歌单歌曲
- 歌单内搜索 / 过滤

主入口：

- [S:\Projects\Active\NetMusicDown\server\playlist-provider.ts](S:\Projects\Active\NetMusicDown\server\playlist-provider.ts)

接口：

- `GET /api/playlists`
- `GET /api/playlists/:id/songs?page=1&limit=100&keyword=...`

分页是为了避免大歌单一次性拉取造成卡顿。当前默认每页 100 首。

## 4.5 云盘音乐

支持读取网易云云盘歌曲列表，并可继续进行：

- 播放
- 试听
- 下载
- 专辑 / 歌手联动

主入口：

- [S:\Projects\Active\NetMusicDown\server\cloud-provider.ts](S:\Projects\Active\NetMusicDown\server\cloud-provider.ts)

接口：

- `GET /api/cloud/songs`

## 4.6 歌手页

歌手页支持：

- 根据歌手 ID 进入
- 根据歌手名兜底解析
- 展示歌手头像、简介、歌曲数、专辑数、MV 数
- 展示热门歌曲列表

多歌手歌曲已支持拆分点击，例如：

- `HOYO-MIX / YMIR`

点击哪位歌手，就进入哪位歌手页，而不是一律进入第一位。

主入口：

- [S:\Projects\Active\NetMusicDown\server\artist-provider.ts](S:\Projects\Active\NetMusicDown\server\artist-provider.ts)

接口：

- `GET /api/artists/:id`
- `GET /api/artists/resolve/by-name?name=歌手名`

## 4.7 专辑页

专辑页支持：

- 根据专辑 ID 进入
- 展示专辑封面、专辑名、歌手、发行信息、简介
- 展示专辑曲目列表

主入口：

- [S:\Projects\Active\NetMusicDown\server\album-provider.ts](S:\Projects\Active\NetMusicDown\server\album-provider.ts)

接口：

- `GET /api/albums/:id`

## 4.8 歌词

歌词能力支持：

- 读取普通歌词
- 失败时回退旧接口
- 尝试兼容逐字歌词返回
- 歌词滚动定位
- 点击歌词跳转播放时间

主入口：

- [S:\Projects\Active\NetMusicDown\server\lyric-provider.ts](S:\Projects\Active\NetMusicDown\server\lyric-provider.ts)

接口：

- `GET /api/lyrics/:id`

## 4.9 喜欢歌曲

底部播放器的红心按钮已经接入网易云接口，不再是纯 UI。

能力：

- 读取当前歌曲是否已喜欢
- 切换喜欢 / 取消喜欢

主入口：

- [S:\Projects\Active\NetMusicDown\server\song-like-provider.ts](S:\Projects\Active\NetMusicDown\server\song-like-provider.ts)

接口：

- `GET /api/likes/:id`
- `POST /api/likes/:id`

## 4.10 下载任务

下载队列目前支持：

- 入队
- 多选歌曲后批量入队
- 本地文件输出
- 任务持久化
- 下载失败自动重试
- 并发限制
- 失败原因记录

主入口：

- [S:\Projects\Active\NetMusicDown\server\task-store.ts](S:\Projects\Active\NetMusicDown\server\task-store.ts)

接口：

- `GET /api/tasks`
- `POST /api/download`

### 下载自动重试规则

当前默认重试上限为 `2` 次。

只对可恢复错误重试，例如：

- 网络抖动
- 上游短时失败

不会对以下硬错误反复重试：

- 试听片段
- Cookie 失效
- 无可用完整音源
- 资源受限

### 批量下载说明

当前歌曲列表支持：

- 左侧勾选单首歌曲
- 勾选当前页多首歌曲
- 对已选歌曲执行批量下载

批量下载链路会：

- 先走一次登录态/会话态校验
- 再逐首调用下载入队
- 汇总成功数、失败数和第一条失败原因

---

## 4.11 媒体访问 ACL 与白名单回退

系统已经引入了受信任白名单与多级凭证回退策略，用于控制媒体流和下载能力。

### 基础规则

- 匿名/未登录请求：直接 `401 Unauthorized`
- 普通登录用户：只能使用其当前会话自己的网易云凭证
- 白名单用户：优先使用自己的凭证；如权限不足且管理员开启了保底开关，则允许回退到系统保底凭证

### 管理员可配置项

设置页当前包含一组高级控制项：

- `Feature Pass Whitelist`
- `System Default Token`
- `启用系统保底回退`

对应接口：

- `GET /api/admin/config`
- `POST /api/admin/config`

后端实现入口：

- [S:\Projects\Active\NetMusicDown\server\media-security.ts](S:\Projects\Active\NetMusicDown\server\media-security.ts)
- [S:\Projects\Active\NetMusicDown\server\settings-store.ts](S:\Projects\Active\NetMusicDown\server\settings-store.ts)

### 当前边界

当前 `/api/admin/config` 已经要求登录后才能访问，但还不是“独立管理员角色控制”。如果后续要继续收紧，可以再增加管理员口令、角色表或仅本地管理员账号可改的限制。

---

## 5. 登录体系

## 5.1 本地账号

项目支持本地演示账号，用于非网易云业务状态展示。

接口：

- `POST /api/account/login`
- `POST /api/account/logout`
- `GET /api/account`

## 5.2 网易云扫码登录

支持二维码登录，包含：

- 生成二维码
- 状态轮询
- 过期自动刷新
- 登录成功后自动写入 Cookie

接口：

- `POST /api/account/netease/qr/start`
- `GET /api/account/netease/qr/check?key=...`

## 5.3 网易云手机号验证码登录

为了解决手机端“扫码扫自己”的问题，项目额外支持：

- 发送验证码
- 手机号 + 验证码登录

接口：

- `POST /api/account/netease/captcha/send`
- `POST /api/account/netease/cellphone/login`

---

## 6. 会话隔离设计

## 6.1 为什么要做

如果所有浏览器窗口共用同一份登录态，会出现：

- 你朋友访问网页时直接看到你的账号
- 无痕窗口仍然是已登录状态
- 多设备测试互相串号

因此项目引入了“按浏览器会话隔离”的设计。

## 6.2 实现方式

前端：

- 在浏览器生成 `clientSessionId`
- 每个 API 请求都附带：
  - Header：`x-client-session-id`
  - 或流接口使用 `sid` query

后端：

- 用 `AsyncLocalStorage` 维护当前请求上下文
- 每个会话拥有独立：
  - 网易云 Cookie
  - 账号状态
  - 设置
  - 历史记录
  - 下载任务归属

关键文件：

- [S:\Projects\Active\NetMusicDown\server\request-context.ts](S:\Projects\Active\NetMusicDown\server\request-context.ts)
- [S:\Projects\Active\NetMusicDown\server\account-store.ts](S:\Projects\Active\NetMusicDown\server\account-store.ts)
- [S:\Projects\Active\NetMusicDown\server\settings-store.ts](S:\Projects\Active\NetMusicDown\server\settings-store.ts)
- [S:\Projects\Active\NetMusicDown\src\api.ts](S:\Projects\Active\NetMusicDown\src\api.ts)

---

## 7. 存储设计

## 7.1 双存储层

项目优先使用 SQLite，但考虑到服务器环境差异，做了回退机制：

- Node 支持 `node:sqlite`：使用 `data/app.db`
- Node 不支持 `node:sqlite`：自动使用 `data/app-store.json`

适配入口：

- [S:\Projects\Active\NetMusicDown\server\database.ts](S:\Projects\Active\NetMusicDown\server\database.ts)

## 7.2 持久化内容

当前已持久化的数据包括：

- 搜索历史
- 播放历史
- 播放器状态
- 设置
- 下载任务

## 7.3 播放器状态持久化

播放器状态可恢复：

- 当前歌曲
- 播放队列
- 播放进度
- 音量
- 播放模式（顺序 / 随机）

存储入口：

- [S:\Projects\Active\NetMusicDown\server\player-state-store.ts](S:\Projects\Active\NetMusicDown\server\player-state-store.ts)

## 7.4 历史记录持久化

已持久化：

- 搜索历史
- 播放历史

存储入口：

- [S:\Projects\Active\NetMusicDown\server\history-store.ts](S:\Projects\Active\NetMusicDown\server\history-store.ts)

---

## 8. 设置项说明

当前设置页的核心项包括：

- 下载目录
- 默认播放音质
- 默认下载音质
- 同时下载任务数限制
- 管理员高级控制（白名单 / 保底凭证 / 保底开关）

### 默认播放音质

影响：

- 试听
- 双击播放
- 底部播放器
- 全屏播放器

当前默认值为：

- `128K`

### 默认下载音质

影响：

- 加入下载队列时的默认音质

默认下载音质与默认播放音质已拆开，互不影响。

如果用户手动为某首歌切换了音质，则该首歌会优先按手动选择处理。

---

## 9. 音频流与 30 秒试听问题处理

网易云某些资源会返回 30 秒试听片段，而不是完整音频。

项目已做处理：

- 播放链路会检查预期时长
- 如果返回的是试听片段，不再当成正常完整播放
- 下载链路也会拦截试听片段，避免误下载

对应逻辑：

- [S:\Projects\Active\NetMusicDown\server\task-store.ts](S:\Projects\Active\NetMusicDown\server\task-store.ts)
- [S:\Projects\Active\NetMusicDown\server\index.ts](S:\Projects\Active\NetMusicDown\server\index.ts)
- [S:\Projects\Active\NetMusicDown\src\api.ts](S:\Projects\Active\NetMusicDown\src\api.ts)

---

## 10. API 清单

以下为当前主要 API：

### 通用

- `GET /api/health`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/player-state`
- `PUT /api/player-state`
- `GET /api/admin/config`
- `POST /api/admin/config`

### 搜索 / 内容

- `GET /api/search?q=...`
- `GET /api/discover/songs`
- `GET /api/recommend/daily`
- `GET /api/lyrics/:id`
- `GET /api/artists/:id`
- `GET /api/artists/resolve/by-name?name=...`
- `GET /api/albums/:id`

### 歌单 / 云盘

- `GET /api/playlists`
- `GET /api/playlists/:id/songs?page=&limit=&keyword=`
- `GET /api/cloud/songs`

### 下载 / 任务

- `GET /api/tasks`
- `POST /api/download`
- `GET /api/stream?id=&level=&expectedDuration=`

### 历史记录

- `GET /api/history/search`
- `PUT /api/history/search`
- `DELETE /api/history/search`
- `GET /api/history/play`
- `PUT /api/history/play`

### 账号与登录

- `GET /api/account`
- `POST /api/account/login`
- `POST /api/account/logout`
- `POST /api/account/netease/qr/start`
- `GET /api/account/netease/qr/check?key=...`
- `POST /api/account/netease/captcha/send`
- `POST /api/account/netease/cellphone/login`
- `POST /api/settings/netease-cookie/check`

### 喜欢歌曲

- `GET /api/likes/:id`
- `POST /api/likes/:id`

---

## 11. 构建与部署

## 11.1 本地开发

```bash
npm install
npm run dev
```

### Windows 网络共享目录注意事项

如果项目是在 UNC 网络路径下运行，例如：

```text
\\10.0.0.240\Server\Projects\Active\NetMusicDown
```

那么直接执行 `npm run dev` 时，`concurrently` 下游的 `cmd.exe` 可能无法以 UNC 路径作为工作目录，表现为：

- 只有 `3010` 后端起来
- `5173` Vite 不会启动

解决方式：

1. 将项目复制到本地盘符路径开发
2. 或先执行 `pushd \\server\share\project` 映射临时盘符，再执行 `npm run dev`

## 11.2 生产构建

```bash
npm run build
```

构建结果：

- 前端：`dist/`
- 后端：`dist-server/`

## 11.3 服务启动

```bash
npm run start
```

## 11.4 当前服务器部署形式

当前项目可采用如下方式部署：

- 部署目录：`/opt/TrackVault`
- 后端启动：`node /opt/TrackVault/dist-server/index.js`
- 由 `systemd` 守护

服务名：

- `trackvault.service`

常用运维命令：

```bash
systemctl restart trackvault.service
systemctl status trackvault.service --no-pager -l
curl http://127.0.0.1:3010/api/health
```

---

## 12. 关键文件说明

### 前端

- [S:\Projects\Active\NetMusicDown\src\App.tsx](S:\Projects\Active\NetMusicDown\src\App.tsx)
  负责绝大多数业务视图、播放器、歌单、歌手、专辑、设置、登录弹窗逻辑。

- [S:\Projects\Active\NetMusicDown\src\api.ts](S:\Projects\Active\NetMusicDown\src\api.ts)
  统一封装前端到后端的请求，并自动附带会话 `sessionId`。

- [S:\Projects\Active\NetMusicDown\src\types.ts](S:\Projects\Active\NetMusicDown\src\types.ts)
  存放前端使用的共享类型。

### 后端

- [S:\Projects\Active\NetMusicDown\server\index.ts](S:\Projects\Active\NetMusicDown\server\index.ts)
  Express 主入口，注册全部 API。

- [S:\Projects\Active\NetMusicDown\server\database.ts](S:\Projects\Active\NetMusicDown\server\database.ts)
  管理 SQLite 与 JSON 回退。

- [S:\Projects\Active\NetMusicDown\server\task-store.ts](S:\Projects\Active\NetMusicDown\server\task-store.ts)
  下载任务队列、任务持久化、音频流检查、重试逻辑。

- [S:\Projects\Active\NetMusicDown\server\netease-auth.ts](S:\Projects\Active\NetMusicDown\server\netease-auth.ts)
  网易云二维码与手机号验证码登录。

---

## 13. 已知限制

- 前端路由目前是状态驱动，不是标准 `react-router`
- UI 经历过大量迭代，结构较大，`App.tsx` 体量偏重
- 多处业务逻辑仍集中在单文件，后续可继续拆分
- 当前仍依赖网易云接口可用性与 Cookie 状态
- 某些资源受版权、会员或上游策略影响，仍可能无法播放或下载

---

## 14. 后续建议

如果继续迭代，推荐优先顺序：

1. 将 `App.tsx` 继续拆分为页面组件、播放器组件、登录组件
2. 补批量加入播放队列、任务筛选与失败任务批量重试
3. 补专辑页与歌手页的进一步联动
4. 为管理员高级控制补真正的角色鉴权
5. 增加本地媒体库管理
6. 为 API 加更清晰的错误码和日志层

---

## 15. 总结

TrackVault 当前已经具备一套完整的“音乐工作台”基础能力：

- 有内容获取能力
- 有试听播放能力
- 有下载与任务管理能力
- 有持久化能力
- 有账号隔离能力
- 有歌手 / 专辑 / 歌词等上下文联动

对个人自用与小范围测试来说，它已经不是一个简单 Demo，而是一套可继续工程化演进的本地音乐平台原型。
