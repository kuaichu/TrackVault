# 歌单互转功能需求与设计草案

## 1. 目标

在 TrackVault 现有“本地音乐工作台”的基础上，新增“歌单互转”能力，让用户可以把一个平台的歌单转换成另一个平台可用的歌单，并在转换过程中清楚看到哪些歌曲成功匹配、哪些歌曲缺失音源、哪些歌曲因为版权或权限不可用。

第一批重点平台：

- 网易云音乐
- QQ 音乐
- 文本歌单 / CSV / Markdown 作为兜底导入导出格式

核心结果不是简单复制一串歌名，而是生成一份可审计的转换报告：

- 可导入目标平台的歌曲列表
- 需要人工确认的候选歌曲
- 目标平台没有找到的歌曲
- 找得到但不可播放、不可加入或需要会员/版权权限的歌曲
- 可直接复制分享的文字歌单

## 2. 当前项目基础

TrackVault 当前已经具备以下可复用能力：

- 网易云登录态管理，包括扫码登录和手机号验证码登录
- 网易云歌单读取、分页、歌单内搜索
- 网易云歌曲搜索
- 网易云歌词、歌手、专辑等信息读取
- 音频流访问检查
- 试听片段识别
- 下载任务失败原因记录

因此新功能不需要从零开始做音乐工作台，而是应新增一个独立的“歌单互转”模块，把现有网易云 provider 能力扩展为可插拔的平台能力。

## 3. 用户场景

### 3.1 网易云歌单导出到 QQ 音乐

用户选择自己的一个网易云歌单，系统读取全部歌曲，然后到 QQ 音乐侧逐首匹配。

系统输出：

- 匹配成功的 QQ 音乐歌曲
- 多个候选时展示候选列表
- QQ 音乐缺失的歌曲
- QQ 音乐存在但无版权、VIP 限制或不可播放的歌曲
- 可复制的文字歌单
- 后续如果支持 QQ 登录，则可一键创建 QQ 歌单并导入匹配成功部分

### 3.2 QQ 音乐歌单导入到网易云

用户可以粘贴 QQ 音乐歌单分享链接、歌单 ID，或先粘贴一份从 QQ 导出的文字歌单。

系统读取或解析出歌曲列表后，到网易云侧逐首匹配，并输出：

- 可加入网易云歌单的歌曲
- 需要人工确认的歌曲
- 网易云没有对应音源的歌曲
- 网易云有歌曲但版权不可用、仅试听片段或需要会员的歌曲

### 3.3 文字歌单互转

当平台接口不可用、登录失败或用户只想保留清单时，系统可以导出纯文本格式：

```text
歌单：示例歌单
来源：网易云音乐
生成时间：2026-06-01 21:00

1. 歌名 - 歌手 - 专辑
2. 歌名 - 歌手 - 专辑

未匹配：
1. 歌名 - 歌手 - 原因：QQ 音乐未找到高置信度匹配

版权受限：
1. 歌名 - 歌手 - 原因：目标平台仅返回试听片段
```

## 4. 功能范围

### 4.1 第一期必须做

- 新增“歌单互转”页面入口
- 支持选择网易云已有歌单作为来源
- 支持粘贴文本歌单作为来源
- 支持导出 Markdown / CSV / JSON / 纯文本
- 支持网易云侧歌曲匹配
- 支持生成匹配报告
- 支持缺失音源、低置信度匹配、重复歌曲识别
- 支持对网易云目标歌曲做基础可用性检查
- 支持人工确认候选歌曲

### 4.2 第二期再做

- 接入 QQ 音乐 provider
- 支持 QQ 音乐分享链接解析
- 支持 QQ 音乐歌单读取
- 支持网易云到 QQ 音乐的匹配报告
- 如果 QQ 侧登录和写入方案稳定，再支持创建 QQ 歌单

### 4.3 暂不做

- 绕过平台版权限制
- 自动下载后上传到另一平台
- 批量搬运本地音频文件
- 公共多用户服务
- 绕过 QQ 或网易云官方风控的登录方案

## 5. 转换流程

### 5.1 导入

来源类型：

- 网易云歌单：使用当前已登录 Cookie 读取
- QQ 音乐歌单：后续通过分享链接、歌单 ID 或登录态读取
- 文本歌单：用户粘贴自由文本
- CSV / JSON：上传结构化文件

导入后统一转换成内部曲目格式：

```ts
type TransferTrack = {
  source: "netease" | "qq" | "text" | "csv";
  sourceTrackId?: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  rawText?: string;
};
```

### 5.2 标准化

标准化规则：

- 去掉首尾空格
- 统一全角/半角符号
- 识别 `歌名 - 歌手`、`歌手 - 歌名`、`歌名 / 歌手` 等常见格式
- 去掉无意义后缀，例如部分平台导出的序号
- 保留关键版本标识，例如 `Live`、`伴奏`、`Remix`、`Cover`
- 多歌手拆分成数组

### 5.3 匹配

匹配优先级：

1. 平台 ID、ISRC 等强标识
2. 歌名完全一致 + 主歌手一致
3. 歌名相似 + 任一歌手一致 + 时长接近
4. 歌名相似 + 专辑一致
5. 仅歌名相似时进入人工确认

每个候选结果给出置信度：

```ts
type MatchCandidate = {
  targetTrackId: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  confidenceScore: number;
  reasons: string[];
};
```

自动通过建议阈值：

- `90-100`：自动匹配
- `70-89`：默认推荐，但需要人工确认
- `0-69`：不自动匹配，列入未确认

### 5.4 可用性检查

每首目标歌曲需要检查：

- 是否能加入目标平台歌单
- 是否存在版权限制
- 是否只返回试听片段
- 是否需要会员
- 是否完全没有可播放音源

当前网易云侧已有音频流检查和试听片段识别，可以先复用到网易云目标检查里。

状态建议：

```ts
type TransferTrackStatus =
  | "matched"
  | "manual_review"
  | "not_found"
  | "copyright_unavailable"
  | "vip_only"
  | "trial_only"
  | "duplicate"
  | "metadata_conflict"
  | "skipped";
```

### 5.5 人工确认

人工确认页需要支持：

- 展示原歌曲信息
- 展示目标平台候选歌曲
- 标记一个候选为正确匹配
- 手动搜索目标平台歌曲
- 标记为找不到
- 跳过
- 保留为文字歌单条目

## 6. 页面设计

建议新增左侧导航：

- 歌单互转

页面分成四步：

1. 选择来源
2. 选择目标
3. 匹配与检查
4. 导出 / 导入

### 6.1 选择来源

控件：

- 来源平台选择：网易云 / QQ 音乐 / 文本 / CSV
- 网易云歌单下拉或卡片选择
- QQ 分享链接输入框
- 文本粘贴区域
- 文件上传

### 6.2 选择目标

控件：

- 目标平台选择：网易云 / QQ 音乐 / 仅导出文本
- 目标歌单名称
- 是否跳过重复歌曲
- 匹配置信度阈值
- 是否检查音源可用性

### 6.3 匹配报告

报告区建议分 Tab：

- 全部
- 已匹配
- 待确认
- 未找到
- 版权 / 权限受限
- 重复

每行展示：

- 原歌曲
- 匹配结果
- 置信度
- 状态
- 原因
- 操作

### 6.4 导出 / 导入

导出格式：

- Markdown
- CSV
- JSON
- 纯文本

如果目标平台写入能力可用，展示：

- 创建新歌单
- 导入到已有歌单
- 仅导入已匹配歌曲
- 导入后生成最终报告

## 7. 后端设计

建议新增目录：

```text
server/
  music-providers/
    types.ts
    netease-provider.ts
    qq-provider.ts
  playlist-transfer/
    import-parser.ts
    matcher.ts
    availability-checker.ts
    export-formatters.ts
    transfer-store.ts
```

平台 provider 统一接口：

```ts
type MusicProvider = {
  id: "netease" | "qq";
  searchTracks(query: string): Promise<ProviderTrack[]>;
  getPlaylistTracks(input: PlaylistInput): Promise<ProviderPlaylist>;
  checkTrackAvailability(trackId: string): Promise<TrackAvailability>;
  createPlaylist?(name: string): Promise<{ id: string }>;
  addTracksToPlaylist?(playlistId: string, trackIds: string[]): Promise<AddTracksResult>;
};
```

新增 API：

```text
POST /api/playlist-transfer/import
POST /api/playlist-transfer/match
GET  /api/playlist-transfer/jobs/:id
POST /api/playlist-transfer/jobs/:id/resolve
POST /api/playlist-transfer/jobs/:id/export
POST /api/playlist-transfer/jobs/:id/create-target-playlist
```

## 8. 数据持久化

建议保存转换任务，方便刷新页面后继续确认：

```ts
type PlaylistTransferJob = {
  id: string;
  sourceProvider: "netease" | "qq" | "text" | "csv";
  targetProvider: "netease" | "qq" | "text";
  playlistName: string;
  tracks: TransferTrackResult[];
  summary: TransferSummary;
  createdAt: string;
  updatedAt: string;
};
```

汇总信息：

```ts
type TransferSummary = {
  total: number;
  matched: number;
  manualReview: number;
  notFound: number;
  unavailable: number;
  duplicate: number;
  skipped: number;
};
```

## 9. 成功标准

第一期完成后应能做到：

- 用户可以选择一个网易云歌单并生成转换任务
- 用户可以粘贴文字歌单并解析出歌曲列表
- 系统能逐首匹配网易云歌曲
- 系统能列出未找到、低置信度、重复和不可用歌曲
- 用户可以手动确认候选歌曲
- 用户可以导出 Markdown / CSV / JSON / 纯文本报告
- 刷新页面后转换任务不会丢失

第二期完成后应能做到：

- 支持 QQ 音乐歌单作为来源
- 支持网易云与 QQ 音乐之间互相生成匹配报告
- 在目标平台接口稳定的前提下，支持一键创建目标歌单并导入成功匹配歌曲

## 10. 风险与待确认问题

### 10.1 QQ 音乐接口稳定性

QQ 音乐没有当前项目里类似 `NeteaseCloudMusicApi` 的既有接入。需要先验证：

- 是否有稳定可用的非官方 API
- 是否支持读取分享歌单
- 是否支持登录态读取私有歌单
- 是否支持创建歌单和批量加歌
- 登录态是否容易失效或触发风控

### 10.2 版权状态识别不一定完全准确

平台返回的版权、会员和可播放状态可能受账号、地区、时间影响。报告里应展示“检测时间”和“检测账号”，避免把一次检测结果当成永久事实。

### 10.3 不能绕过版权

这个功能只做识别、转换、报告和合法导入，不做版权绕过、破解、搬运音频文件。

### 10.4 App.tsx 体量偏大

当前 `src/App.tsx` 已经承载大量页面逻辑。新增歌单互转时建议建立独立 feature 目录，避免继续扩大单文件复杂度。

## 11. 推荐实施顺序

1. 抽象 `MusicProvider` 类型，先包一层网易云 provider。
2. 新增文本歌单解析器和导出 formatter。
3. 新增转换任务存储。
4. 实现网易云目标匹配和报告生成。
5. 新增“歌单互转”页面。
6. 接入人工确认流程。
7. 补充 Markdown / CSV / JSON / 纯文本导出。
8. 调研并接入 QQ 音乐 provider。
9. 最后再评估目标平台写入能力。

