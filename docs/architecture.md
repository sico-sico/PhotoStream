# 架构与实现

面向修改代码的人。使用与编译说明请见 [README](../README.md)。

- [架构与实现](#架构与实现)
  - [技术选型](#技术选型)
  - [实现细节](#实现细节)
    - [拖动性能](#拖动性能)
    - [滚动条预取](#滚动条预取)
    - [拖入 / 命令行打开](#拖入-命令行打开)
    - [EXIF 面板：一个被记住的偏好](#exif-面板一个被记住的偏好)
    - [递归扫描](#递归扫描)
    - [打开文件夹时的磁盘 I/O 与 Defender](#打开文件夹时的磁盘-io-与-defender)
    - [EXIF 时区](#exif-时区)
    - [元数据缓存的作用域](#元数据缓存的作用域)
    - [缩小的下限由内容决定](#缩小的下限由内容决定)
    - [小图的 zoom 档位是冗余的](#小图的-zoom-档位是冗余的)
    - [缩略图缓存分片](#缩略图缓存分片)
    - [滚轮手势](#滚轮手势)
    - [文件锁](#文件锁)
    - [设置文件 BOM](#设置文件-bom)
    - [持久化时序](#持久化时序)
    - [工具栏样式失效](#工具栏样式失效)
  - [测试策略](#测试策略)
    - [用真实照片库校验](#用真实照片库校验)
    - [端到端的边界](#端到端的边界)
  - [项目结构](#项目结构)
  - [添加语言](#添加语言)

## 技术选型

| 方面 | 选择 | 原因 |
|------|------|------|
| 运行时 | Electron 44（Chromium 152 / Node 24） | 图像处理生态成熟，前端开发效率高 |
| 缩略图 | `sharp`（libvips） | 实测 512px WebP 约 1.2 ms/张，比 `nativeImage.createThumbnailFromPath` 快 5.5 倍、体积小 10 倍 |
| EXIF | `sharp.metadata()` + `exif-reader` | `exif-reader` 零依赖且仍在维护；`exifr` 已 4.5 年未更新 |
| 元数据缓存 | `node:sqlite`（Electron 内置） | 不需要额外原生模块，也不必为几万行数据手写文件格式 |
| 图像尺寸 | `image-size` | 从同一个 512 KB 前缀里拿宽高，EXIF 在这些导出里不含像素尺寸 |
| 画布 | 单容器 CSS `transform` + 视口裁剪 | 见[拖动性能](#拖动性能) |
| 文件监听 | Node 内置 `fs.watch` | 少一个依赖，避开 ESM/CJS 问题；本应用只面向 Windows |
| 打包 | `@electron/packager` | `electron-builder` 会引入 8 个已知漏洞和 4 个弃用包 |
| 类型系统 | TypeScript 7 | 原生 Go 实现，类型检查快一个数量级；迁移只需去掉 `baseUrl` 并显式声明 CSS 导入 |

主进程实际用到三个第三方包，它们被打包的方式不同：

| 包 | 声明位置 | 打包方式 |
|---|---|---|
| `sharp` | `dependencies` | 原生二进制，需要从 `app.asar` 解包（`asar.unpack`） |
| `exif-reader` | `dependencies` | 纯 JS，由 `externalizeDepsPlugin` 外部化后随 `node_modules` 一起进包 |
| `image-size` | `devDependencies` | 纯 JS，体积小且无副作用，被 Vite 直接内联进 `out/main/index.js` |

`image-size` 放在 `devDependencies` 是有意为之：它会被打进 bundle，运行时不需要在 `node_modules` 里找到它。若将来改成外部化，必须同时把它移到 `dependencies`，否则打包后会在启动时 `MODULE_NOT_FOUND`。

选型前的完整实测过程见 [research.md](./research.md)。

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

### EXIF 面板：一个被记住的偏好

`viewerInfo` 描述的是**用户想怎么看图**，不是某张照片的属性，所以它跨照片、跨关闭重开、跨重启都保持。

早期实现把它当成「单张照片」的意图：点击瓦片或 `←/→` 翻页时清除。结果是用户按下 `I` 打开面板，翻到下一张就自己关掉——看起来像功能坏了。现在：

- 点瓦片、翻页、关闭再打开查看器都不会改变它；
- 按 `I`、点工具栏按钮、点面板自己的关闭按钮都会把选择写回 `wallReducer`，并入 `Settings` 持久化（`settings.json` 的 `viewerInfo`）；
- 只有「从外部打开某一张照片」（拖入单个文件、资源管理器「打开方式」）会把它**置为 true**，因为此时文件详情正是用户所问；它从不会主动置为 false。

控件是受控的：`Viewer` 只接收 `infoOpen` 并通过 `onInfoOpenChange` 上报，状态归属墙，否则偏好无法持久化。

### 递归扫描

开启子文件夹后会递归遍历，三个约束：

- 用 `realpath` 记录已访问目录，避免 junction/symlink 成环；另有 `MAX_SCAN_DEPTH = 24` 作为兜底。
- 跳过 `.` 开头的目录和 `node_modules`、`$RECYCLE.BIN` 一类目录。
- 返回的 `name` 是**相对路径**（`2024/a.jpg`），否则不同子目录里的同名文件会互相覆盖。

监听器本身始终是递归的，但关闭该选项时会过滤掉子目录事件——否则扫描结果和实时更新会不一致。

### 打开文件夹时的磁盘 I/O 与 Defender

应用**从不**启动子进程（代码里没有 `child_process`、`spawn`、`exec`），也不会主动调用任何杀毒软件。打开文件夹时 Defender 活动上升，是因为它作为文件系统过滤驱动挂了「实时保护」，**我们读的每个文件都要经过它扫描**。这是 Windows 的固有行为，不是应用的问题。

扫描阶段的 I/O 量来自 EXIF 前缀读取：每张照片读 512 KB。3226 张的库因此约读取 **1.6 GB**（库本身 42.5 GB）。512 KB 这个值有实测依据：64 KB 会漏掉 151 张（EXIF 段落在其后），而整轮解析约 1.1 ms/张。

实测（`scripts/diagnose-defender-load.mjs`，每 200ms 采样 `MsMpEng` 的 CPU）：

| 库 | 张数 | 扫描耗时 | Defender 峰值 CPU | Defender 平均 | 对照（explorer） |
|---|---|---|---|---|---|
| Cosplay | 309 | 209 ms | **34%** | 11.3% | 0% |
| Export | 3226 | 1671 ms | **28%** | 8.3% | 0% |

对照组 `explorer.exe` 全程 0%，说明上升确实来自文件扫描而非采样噪声。

缓存命中后几乎不读文件，I/O 与 Defender 活动都会消失——这也是把 `retain` 的作用域限制在当前目录的原因之一（见上文元数据缓存）。

若要进一步降低影响，可行的方向是缩小前缀读取（需要重新实测命中率），或提示用户把照片目录加入 Defender 排除列表；后者需要管理员权限，且会降低安全性，因此只作为文档建议，不在应用内代做。

### EXIF 时区

`exif-reader` 把拍摄时间当作 UTC 构造 `Date`。必须用 `getUTC*` 读取，用本地时间访问器会让日期偏移一天。已用 3226 张真实照片验证：`getUTC*` 全部正确，本地访问器全部错误。

### 元数据缓存的作用域

`MetadataCache` 用一张 SQLite 表服务用户打开过的**所有**文件夹，所以清理时必须限定范围。

早期实现是 `DELETE FROM photo_metadata WHERE path NOT IN (...)`，只传当前扫描到的路径。后果是**打开另一个文件夹会删光前一个文件夹的全部缓存行**——而「最近文件夹」菜单的全部意义就是来回切换。实测（`Export` 3226 张 / `Cosplay` 309 张）：

| 操作 | 修复前 | 修复后 |
|---|---|---|
| 首次打开 Export | 3960 ms | 3960 ms |
| 切到 Cosplay，再回 Export | **1387 ms** | **107 ms** |
| 再次切到 Cosplay | 141 ms | **10 ms** |

`retain(dir, paths)` 现在只处理 `dir` 下的行。两个 LIKE 前缀分别对应 `/` 和 `\`（数据库里是 Windows 路径，测试里是 POSIX 风格）；转义字符用 `!` 而不是 `\`，因为后者既是路径分隔符又是 SQL 的默认转义符。

### 缩小的下限由内容决定

滚轮能缩到多小不是风格问题，而是几何约束。缩放系数 `s` 下，墙面覆盖 `墙面积 × s²` 个屏幕像素；一旦小于窗口面积，**任何布局都填不满**，`clampWallTransform` 会把墙居中，表现为一条细带漂在空白里。3226 张时该下限是 `sqrt(窗口面积 / 墙面积) ≈ 0.0826`，而滚轮允许到 0.05。

叠加的第二个约束是挂载上限：渲染层最多挂 `MAX_MOUNTED_TILES = 600` 个瓦片，超出的直接被丢弃——也就是「缩小后有些照片不显示」。两者叠加后，只有下限抬高到 **0.3118** 才既不丢图也不留白。

`minScaleForTiles` 用二分法对真实布局求解，而非一个公式：可见瓦片数随缩放**不是平滑函数**，因为布局会按整列/整行重排。注意必须用与挂载**相同的 margin**（`CULL_MARGIN`）测量，否则会少算约三分之一，下限压低后上限依然被突破。

还有一个更隐蔽的坑：缩略图**请求集合**曾与**挂载集合**用了两套规则（一个用 `max(宽,高)` 作 margin 并按布局顺序，另一个用 900px 固定 margin 并按中心距离截断）。两者几乎不重叠，导致挂载的 600 个瓦片**全部无图**。现在两者都来自 `useWall` 里同一次 `cullItems` 调用，由构造保证一致。

### 小图的 zoom 档位是冗余的

`buildThumbnail` 用 `withoutEnlargement`，所以原图小于 512px 时，`wall` 和 `zoom` 两档会编码出**同样的像素**，只是 WebP 质量不同。实测 300×200 的 JPEG：`wall` 200 B、`zoom` 192 B——两次编码、两个文件、一份信息。

`zoomTierAddsDetail(width, height)` 判定长边是否超过 `wall` 档位，`effectiveLevel` 据此把这类照片的 `zoom` 请求重定向到 `wall` 文件。尺寸来自扫描时已解析的 `photo.width/height`，不需要额外读文件。尺寸未知时保守保留独立文件：多一个文件只费磁盘，少一个会让瓦片永远模糊。

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

### 滚轮手势

裸滚轮平移、`Ctrl`（macOS 上是 `Cmd`）+ 滚轮缩放。原来反过来：裸滚轮直接缩放，`ctrlKey` 根本没读。

改的原因是习惯：浏览器、图片查看器、地图都是「滚轮滚动页面」，用户第一次尝试的动作是往下滚，结果改变了缩放而不是沿着图库移动。

两个细节：

- Windows 的 Chrome/Firefox 把触控板捏合合成为 `ctrlKey: true` 的 wheel 事件，所以这个判断顺带让触控板捏合可用，不需要单独的识别器。
- 必须 `preventDefault`：Chromium 会把 Ctrl+滚轮当成**页面缩放**，不拦住的话整个界面会跟着变大。

`shared/wheel.ts` 把判断和位移量算成纯函数（`wheelIntent` / `wheelPan`），所以不用起 Electron 就能测。`deltaMode` 也在这里归一化——鼠标报像素、部分驱动报行/页。

单张查看页保持裸滚轮缩放：那里没有可滚动的内容，滚轮只有一个合理含义。

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
npm run test             # 939 个单元/集成测试（56 个文件）
npm run test:coverage    # 覆盖率门槛：70%
npm run test:e2e         # 32 个 Playwright 端到端测试
npm run verify           # 以上全部
```

覆盖率（当前）：语句 90.2%、分支 82.4%、函数 89.3%、行 93.1%。

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
   ├─ transform.ts      平移缩放数学（含边界钳制、缩放下限）
   ├─ cull.ts           视口裁剪 + 滚动目标预取
   ├─ scrollbar.ts      滚动条几何与日期映射
   ├─ keyboard.ts       键盘平移与方向键选择
   ├─ reanchor.ts       重排后保持视觉中心
   ├─ history.ts        最近文件夹的去重与上限
   ├─ filters.ts        筛选逻辑（含通配符匹配与转义）
   ├─ exif.ts           EXIF 展示分组与格式化
   ├─ gesture.ts        点击与拖拽判定
   ├─ pinch.ts          双指缩放的状态机
   ├─ wheel.ts          滚轮意图判定（平移 / 缩放）
   ├─ thumbs.ts         缩略图档位、缓存键与 LOD 选层
   ├─ date.ts           EXIF 日期规范化
   ├─ photoStore.ts     增删与统一排序规则
   ├─ ipc.ts            IPC 通道名与协议主机常量
   ├─ types.ts          跨进程共享类型与设置默认值
   └─ i18n/             消息目录与语言注册表
```

渲染层还包含 `App.tsx`（组装与全局快捷键）和 `i18n/`（语言上下文与提供者）。

## 添加语言

英文目录是唯一的来源，它定义在 `src/shared/i18n/messages.ts` 里，`Catalog` 类型由它推导——所以**漏译会在编译期报错**。

1. 新建 `src/shared/i18n/locales/de.ts`：

```ts
import type { Catalog } from '../messages'

export const de: Catalog = {
  // 复制 messages.ts 里 en 的键并填入译文
}
```

2. 在 `src/shared/i18n/locales/index.ts` 中登记（同时记得在 `package.mjs` 的 `KEPT_LOCALES` 里加上对应的 Chromium 语言包，否则文件对话框等系统界面仍是英文）：

```ts
import { de } from './de'

export const BUILTIN_LOCALES: readonly LocaleDefinition[] = [
  // ...
  { id: 'de', label: 'Deutsch', catalog: de }
]
```

第三方也可在运行时注入，无需改源码：

```ts
import { locales } from '@shared/i18n'
locales.register({ id: 'de', label: 'Deutsch', catalog: de })
```
