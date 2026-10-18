# 架构与实现

面向修改代码的人。使用与编译说明请见 [README](../README.md)。

- [技术选型](#技术选型)
- [实现细节](#实现细节)
  - [拖动性能](#拖动性能)
  - [滚动条预取](#滚动条预取)
  - [拖入 / 命令行打开](#拖入--命令行打开)
  - [递归扫描](#递归扫描)
  - [EXIF 时区](#exif-时区)
  - [文件锁](#文件锁)
  - [设置文件 BOM](#设置文件-bom)
  - [持久化时序](#持久化时序)
  - [工具栏样式失效](#工具栏样式失效)
- [测试策略](#测试策略)
- [项目结构](#项目结构)
- [添加语言](#添加语言)

## 技术选型

| 方面 | 选择 | 原因 |
|------|------|------|
| 运行时 | Electron 44（Chromium 152 / Node 24） | 图像处理生态成熟，前端开发效率高 |
| 缩略图 | `sharp`（libvips） | 实测 512px WebP 约 1.2 ms/张，比 `nativeImage.createThumbnailFromPath` 快 5.5 倍、体积小 10 倍 |
| EXIF | `sharp.metadata()` + `exif-reader` | `exif-reader` 零依赖且仍在维护；`exifr` 已 4.5 年未更新 |
| 元数据缓存 | `node:sqlite`（Electron 内置） | 不需要额外原生模块，也不必为几万行数据手写文件格式 |
| 画布 | 单容器 CSS `transform` + 视口裁剪 | 见[拖动性能](#拖动性能) |
| 文件监听 | Node 内置 `fs.watch` | 少一个依赖，避开 ESM/CJS 问题；本应用只面向 Windows |
| 打包 | `@electron/packager` | `electron-builder` 会引入 8 个已知漏洞和 4 个弃用包 |
| 类型系统 | TypeScript 7 | 原生 Go 实现，类型检查快一个数量级；迁移只需去掉 `baseUrl` 并显式声明 CSS 导入 |

运行时依赖只有 `sharp` 和 `exif-reader` 两个。选型前的完整实测过程见 [research.md](./research.md)。

## 实现细节

改动相关代码前值得先读的部分。

### 拖动性能

3226 张照片时拖动卡顿，逐项测量排除了几个想当然的病因：

| 假设 | 实测 |
|------|------|
| transform 写入太慢 | 0.51 ms/次，不是原因 |
| box-shadow 太多 | 去掉全部阴影后仍 28 ms/帧 |
| 字幕文本重绘 | 隐藏后反而更慢 |
| 视差/布局刷新 | 强制 style+layout 仅 3.6 ms |
| **同时挂载的 DOM 节点数** | **3026 个 → 27 ms/帧；只留 200 个 → 17 ms/帧** |

即使完全不经过 React、直接写 `style.transform` 也只有 26 ms/帧，所以瓶颈是节点数量本身。两个修复：

1. **视口裁剪**（`shared/cull.ts`）：只挂载可见区域加一屏边距的瓦片，上限 600 个。
2. **拖动期间直写 DOM**（`usePanZoom` + `Wall` 的 `applyTransform`）：每帧只改 `style.transform`，松手时提交一次 React 状态。

结果：DOM 瓦片 3226 → 64，帧时间中位数 **17 ms（60 fps）**，p95 17 ms，超时帧 0。

### 滚动条预取

竖向滚动条暴露出视口裁剪的另一个失效场景：滚动条可以一步跳过几万像素，而缩略图是按**当前视口**请求的，于是跳转落地后满屏都是占位图。

修复在 `shared/cull.ts` 的 `prefetchIdsForScroll`：按**目标位置**（而不是当前位置）算出前后各一屏的区间，提前发起请求，跳转动画播放期间缩略图就已经在路上了。区间按缩放换算，保证任何缩放级别下都覆盖同样多的屏幕内容。

**实测推翻的第一版设计。** 最初的实现一次预取整个区间（数百张），结果跳转后 15 秒仍有 14/81 张可见瓦片是空白——因为主进程只有 4 个编码槽，预取把**已经在屏幕上的**瓦片挤到了队尾。改法有两处：

1. 预取批量收到 80 张（约一屏），并延后 120 ms 发起，让当前视口先赢；
2. 主进程的编码队列改为**双通道**（`interactive` / `background`），预取走后者，永远排在可见瓦片之后。

另外，滚动条拖动会连续发出大量指针事件，所以目标值先落到 state 再由 effect 合并——每个不同的目标只发一次批量请求，而不是每个像素发一次。

### 拖入 / 命令行打开

两个入口最终走同一条路径，避免行为漂移：

1. **拖入**：`useFileDrop` 从 `File` 取回真实路径（Electron 32 起 `File.path` 已移除，必须用 `webUtils.getPathForFile`），再调 `openDropped`。
2. **命令行**：`photoFromArgv` 从 `process.argv` 里挑出第一个 JPEG；主进程通过 `photos:openExternal` 通知转发给渲染层。

主进程的 `resolveOpenTarget` 统一判定：目录就开目录，JPEG 文件就开它所在的目录并返回该文件路径。渲染层拿到后聚焦这张照片并展开 EXIF 面板。

两个坑：

- **单实例**：每次「打开方式」都会起新进程，所以加了 `requestSingleInstanceLock`，第二个实例把参数转交给第一个后退出。
- **EXIF 面板只在外部打开时自动展开**。点墙上的瓦片只是「看这张图」，面板会挡住照片。因此 `viewerInfo` 是**单张照片**的属性：点击瓦片或 `←/→` 翻页时清除，否则翻到下一张仍会自动展开。

### 递归扫描

开启子文件夹后会递归遍历，三个约束：

- 用 `realpath` 记录已访问目录，避免 junction/symlink 成环；另有 `MAX_SCAN_DEPTH = 24` 作为兜底。
- 跳过 `.` 开头的目录和 `node_modules`、`$RECYCLE.BIN` 一类目录。
- 返回的 `name` 是**相对路径**（`2024/a.jpg`），否则不同子目录里的同名文件会互相覆盖。

监听器本身始终是递归的，但关闭该选项时会过滤掉子目录事件——否则扫描结果和实时更新会不一致。

### EXIF 时区

`exif-reader` 把拍摄时间当作 UTC 构造 `Date`。必须用 `getUTC*` 读取，用本地时间访问器会让日期偏移一天。已用 3226 张真实照片验证：`getUTC*` 全部正确，本地访问器全部错误。

### 缩略图缓存分片

一个缓存目录服务用户打开过的**所有**文件夹，每张照片最多 2 个档位，所以文件数增长比照片数更快。扁平目录在 3 千个文件时还好，到十万级时枚举、删除和资源管理器都会变慢。

缓存键因此是分层的相对路径（`shared/thumbs.ts` 的 `thumbKey`）：

```
thumbs/a/b/<16位hash>-wall.webp
```

- **两级、每级 1 个十六进制字符**，共 256 个叶子目录。分片取自哈希本身，所以同一张照片永远落在同一个目录，查找仍是 O(1)。
- `thumbKey` 返回**相对路径**（用 `/`），调用方负责建目录和拼 URL。
- `pic://thumb` 的 URL 要**逐段编码**。整体 `encodeURIComponent` 会把分隔符变成 `%2F`，得到一个浏览器视为单一不透明段的 URL；解码端也必须逐段解码，否则 `%2F` 会在切分之后才变成分隔符——那正是路径穿越防护最不该有的歧义。

这个结构与 Lightroom 的 `.lrdata` 一致（16 个一级目录 + 十六进制二级目录）。实测 83 个缓存文件摊在 69 个叶子目录里，每个最多 3 个。

没有照搬 LR 的部分：它用**内容指纹**做键（照片改名后预览仍命中），因为它维护的是可任意重排的目录库；我们的键是 `路径+mtime+size`，照片改名就重算，更简单也不会错。它还把 JPEG 内嵌进 `root-pixels.db` 以便原图离线时仍能预览——我们不需要，但代价是数据库从 0.8 MB 涨到百 MB 级。

### 文件锁

libvips 会缓存解码结果并持有源文件句柄，导致用户在 Lightroom 里重新导出同名照片时写入失败。`thumbnails.ts` 调用 `sharp.cache(false)` 解决，并有回归测试守护。

### 设置文件 BOM

Windows 编辑器（记事本、PowerShell）会在 UTF-8 文件前加 BOM，`JSON.parse` 会拒绝。`settings-store.ts` 在解析前剥离，否则用户手改配置文件后所有设置会被静默重置。

### 持久化时序

`useWall` 必须等设置读取完成后才允许写盘。React 的 effect 按声明顺序执行，用 ref 做守卫会在首次渲染时就通过，导致默认值覆盖用户配置。

### 工具栏样式失效

`.history-caret` 规则块漏了闭合括号，导致其后所有 CSS 规则被丢弃——表现为「整个工具栏的按钮都变丑了」。这不是审美问题，是解析失败。修改 `styles.css` 后建议先做一次括号平衡检查。

## 测试策略

```bash
npm run typecheck        # 同时检查 main/preload 与 renderer
npm run test             # 863 个单元/集成测试（48 个文件）
npm run test:coverage    # 覆盖率门槛：70%
npm run test:e2e         # 31 个 Playwright 端到端测试
npm run verify           # 以上全部
```

覆盖率（当前）：语句 86.9%、分支 80.8%、函数 85.8%、行 89.4%。

分层：

- **纯逻辑**（`src/shared`）：布局、变换、裁剪、滚动、筛选、手势、i18n、最近文件夹 — 无 IO，可直接断言。
- **主进程**（`src/main`）：真实临时目录 + 真实 JPEG，覆盖扫描、递归、EXIF、缩略图、协议安全、文件监听、路径解析。
- **渲染层**（`src/renderer`）：React Testing Library，覆盖组件、reducer、拖拽/缩放/拖放 hook。
- **端到端**（`tests/e2e`）：启动真实 Electron，走完整 IPC + `pic://` 协议 + sharp 链路。

### 用真实照片库校验

```bash
npm run verify:library -- "D:\你的照片目录"
```

输出 EXIF 识别率、日期范围和耗时。不会修改任何文件。

### 端到端的边界

`contextBridge` 暴露的 API 是**冻结**的，因此测试无法替换 `window.photoStream` 上的方法——`useFileDrop` 的路径解析、拖放的真实触发都只能在单元测试里覆盖。E2E 只断言真正可观测的部分（覆盖层反应、主进程打开真实目录），不假装测过写不进去的路径。

## 项目结构

```
src/
├─ main/                主进程
│  ├─ index.ts          窗口、单实例、命令行入口
│  ├─ ipc.ts            PhotoLibrary：扫描、监听、缩略图队列、协议根
│  ├─ drop.ts           把拖入/命令行路径解析为「目录 + 待聚焦照片」
│  ├─ scanner.ts        目录扫描（含递归）
│  ├─ metadata.ts       EXIF 与尺寸解析
│  ├─ metadata-cache.ts SQLite 元数据缓存
│  ├─ thumbnails.ts     sharp 缩略图生成 + 双通道编码队列
│  ├─ watcher.ts        fs.watch 封装
│  ├─ protocol.ts       pic:// 协议（安全边界）
│  ├─ settings-store.ts 设置读写与校验
│  └─ paths.ts          便携数据目录
├─ preload/             contextBridge 白名单 API
├─ renderer/            React 界面
│  ├─ components/       Toolbar / Wall / Tile / Viewer / FilterPanel
│  │                   SortPicker / HistoryMenu / Scrollbar / InfoPanel
│  │                   AboutDialog / Logo / Menu / WindowControls
│  ├─ hooks/            useWall（状态编排）、usePanZoom（手势）、useFileDrop（拖入）
│  ├─ state/            wallReducer（纯 reducer）
│  └─ i18n/             语言上下文
└─ shared/              主进程与渲染层共用
   ├─ layout.ts         三种布局算法
   ├─ transform.ts      平移缩放数学（含边界钳制）
   ├─ cull.ts           视口裁剪 + 滚动目标预取
   ├─ scrollbar.ts      滚动条几何与日期映射
   ├─ keyboard.ts       键盘平移与方向键选择
   ├─ reanchor.ts       重排后保持视觉中心
   ├─ history.ts        最近文件夹的去重与上限
   ├─ filters.ts        筛选逻辑（含通配符匹配与转义）
   ├─ exif.ts           EXIF 展示分组与格式化
   ├─ gesture.ts        点击与拖拽判定
   ├─ photoStore.ts     增删与统一排序规则
   └─ i18n/             消息目录与语言注册表
```

## 添加语言

1. 在 `src/shared/i18n/locales/` 新建文件，导出类型为 `Catalog` 的目录：

```ts
import type { Catalog } from '../messages'

export const de: Catalog = {
  // 复制 en.ts 的键并填入译文
}
```

因为 `Catalog` 由英文目录推导，**漏译会在编译期报错**。

2. 在 `locales/index.ts` 的 `BUILTIN_LOCALES` 中登记：

```ts
{ id: 'de', label: 'Deutsch', catalog: de }
```

第三方也可在运行时注入，无需改源码：

```ts
import { locales } from '@shared/i18n'
locales.register({ id: 'de', label: 'Deutsch', catalog: de })
```
