# PhotoStream

桌面照片墙：自由拖动、滚轮缩放、竖向滚动条定位、拖入即开、单张查看。便携版，无需安装。

![Electron](https://img.shields.io/badge/Electron-44-blue) ![React](https://img.shields.io/badge/React-19-61dafb) ![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6)

Windows 上可以直接右键某张照片 →「打开方式」→ PhotoStream：会打开它所在的文件夹并放大这张照片。

## 功能

- **照片墙**：读取一个文件夹的 JPEG，按 EXIF 拍摄时间排序（默认最新在前），任意方向拖动，滚轮以光标为锚点缩放。
- **竖向滚动条**：按比例定位，拖动时在滑块旁显示落点日期；支持 `Home`/`End`/`PageUp`/`PageDown`。
- **拖入打开**：把文件夹或任意一张照片拖到窗口任意位置即可打开。拖照片会打开它所在的文件夹、放大它，并展开 EXIF 详情。
- **从资源管理器打开**：右键 →「打开方式」→ PhotoStream 与拖入单张照片行为一致。已运行时会转交给现有窗口，不会开第二个实例。
- **最近文件夹**：记住最近 12 个打开过的文件夹，可从「打开文件夹」右侧的下拉里重新打开，也可删除单条或全部清除。
- **子文件夹**：齿轮菜单里的「包含子文件夹中的照片」，默认关闭。打开后会递归扫描，并忽略 `.开头的隐藏目录`、`node_modules` 等缓存目录。
- **键盘导航**：方向键平移画布；`Alt` + 方向键在照片之间移动焦点；`Shift` 加速。
- **三种布局**：等高行（保留比例）、瀑布流（保留比例）、正方形网格。
- **排序**：最新优先 / 最早优先 / 名称 A→Z / 名称 Z→A，选择会被记住。
- **筛选**：日期范围（来自 EXIF）+ 文件名匹配。文件名支持通配符：`*` 匹配任意多个字符，`?` 匹配单个字符；不含通配符时按「包含」匹配。
- **单张查看**：先显示缓存缩略图，原图解码完成后无感替换；滚轮/双指缩放、拖拽平移、旋转、`←/→` 翻页、`Esc` 关闭；按 `I` 展开 EXIF 详情。
- **文件监听**：新增、覆盖、删除照片都会实时反映到墙上，无需重新打开文件夹。
- **多语言**：中文（简体）、English、Français，默认跟随系统语言，可运行时切换。
- **无边框窗口**：自绘标题栏与窗口按钮，工具栏空白处拖动窗口。
- **关于对话框**：齿轮菜单里查看版本、运行时版本、数据目录与快捷键一览。
- **便携**：所有数据写在 exe 同级的 `PhotoStreamData/`，整个目录可随意移动。

## 快速开始

```bash
npm install          # 需要 Node >= 22.12（开发机使用 Node 24 LTS）
npm run dev          # 开发模式
npm run dist         # 打包绿色版到 release/
```

`npm run dist` 产出 `release/PhotoStream-portable-win-x64/`，运行其中的 `PhotoStream.exe` 即可。

修改应用图标：编辑 `build/icon.svg`，然后 `npm run icon` 重新生成 `icon.ico`（16/24/32/48/64/128/256）与 `icon.png`。

## 技术选型

| 方面 | 选择 | 原因 |
|------|------|------|
| 运行时 | Electron 44（Chromium 152 / Node 24） | 图像处理生态成熟，前端开发效率高 |
| 缩略图 | `sharp`（libvips） | 实测 512px WebP 约 1.2 ms/张，比 `nativeImage.createThumbnailFromPath` 快 5.5 倍、体积小 10 倍 |
| EXIF | `sharp.metadata()` + `exif-reader` | `exif-reader` 零依赖且仍在维护；`exifr` 已 4.5 年未更新 |
| 画布 | 单容器 CSS `transform` + 视口裁剪 | 见下方「拖动性能」 |
| 文件监听 | Node 内置 `fs.watch` | 少一个依赖，避开 ESM/CJS 问题；本应用只面向 Windows |
| 打包 | `@electron/packager` | `electron-builder` 会引入 8 个已知漏洞和 4 个弃用包 |
| 类型系统 | TypeScript 7 | 原生 Go 实现，类型检查快一个数量级；迁移只需去掉 `baseUrl` 并显式声明 CSS 导入 |

详细的实测数据见 [`research.md`](./research.md)。

## 关键实现细节

这些是踩过的坑，改动相关代码前值得先读。

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

### 拖入 / 右键打开

两个入口最终走同一条路径，避免行为漂移：

1. **拖入**：`useFileDrop` 从 `File` 取回真实路径（Electron 32 起 `File.path` 已移除，必须用 `webUtils.getPathForFile`），再调 `openDropped`。
2. **右键「打开方式」**：Windows 以命令行参数传入文件，`photoFromArgv` 从 `process.argv` 里挑出第一个 JPEG；主进程通过 `photos:openExternal` 通知转发给渲染层。

主进程的 `resolveOpenTarget` 统一判定：目录就开目录，JPEG 文件就开它所在的目录并返回该文件路径。渲染层拿到后聚焦这张照片并展开 EXIF 面板。

两个坑：

- **单实例**：「打开方式」每次都起新进程，所以加了 `requestSingleInstanceLock`，第二个实例把参数转交给第一个后退出。
- **EXIF 面板只在外部打开时自动展开**。点墙上的瓦片只是「看这张图」，面板会挡住照片。因此 `viewerInfo` 是**单张照片**的属性：点击瓦片或 `←/→` 翻页时清除，否则翻到下一张仍会自动展开。

### 滚动条预取

有了竖向滚动条之后，暴露出视口裁剪的另一个失效场景：滚动条可以一步跳过几万像素，而缩略图是按**当前视口**请求的，于是跳转落地后满屏都是占位图。

修复在 `shared/cull.ts` 的 `prefetchIdsForScroll`：按**目标位置**（而不是当前位置）算出前后各一屏的区间，提前发起请求，跳转动画播放期间缩略图就已经在路上了。边界条件：

- 区间按缩放换算，保证任何缩放级别下都覆盖同样多的屏幕内容；
- 上限复用 `MAX_MOUNTED_TILES`，一次跳转不会把整个图库都排进队列；
- 拖动时滚动条会连续发出大量指针事件，因此目标值先落到 state 再由 effect 合并——每个不同的目标只发一次批量请求，而不是每个像素发一次。

**实测推翻的第一版设计。** 最初的实现一次预取整个区间（数百张），结果跳转后 15 秒仍有 14/81 张可见瓦片是空白——因为主进程只有 4 个编码槽，预取把**已经在屏幕上的**瓦片挤到了队尾。改法有两处：

1. 预取批量收到 80 张（约一屏），并延后 120 ms 发起，让当前视口先赢；
2. 主进程的编码队列改为**双通道**（`interactive` / `background`），预取走后者，永远排在可见瓦片之后。

### EXIF 时区

`exif-reader` 把拍摄时间当作 UTC 构造 `Date`。必须用 `getUTC*` 读取，用本地时间访问器会让日期偏移一天。已用 3226 张真实照片验证：`getUTC*` 全部正确，本地访问器全部错误。

### 文件锁

libvips 会缓存解码结果并持有源文件句柄，导致用户在 Lightroom 里重新导出同名照片时写入失败。`thumbnails.ts` 调用 `sharp.cache(false)` 解决，并有回归测试守护。

### 设置文件 BOM

Windows 编辑器（记事本、PowerShell）会在 UTF-8 文件前加 BOM，`JSON.parse` 会拒绝。`settings-store.ts` 在解析前剥离，否则用户手改配置文件后所有设置会被静默重置。

### 持久化时序

`useWall` 必须等设置读取完成后才允许写盘。React 的 effect 按声明顺序执行，用 ref 做守卫会在首次渲染时就通过，导致默认值覆盖用户配置。

## 测试

```bash
npm run typecheck        # 同时检查 main/preload 与 renderer
npm run test             # 861 个单元/集成测试
npm run test:coverage    # 覆盖率门槛：70%
npm run test:e2e         # 31 个 Playwright 端到端测试
npm run verify           # 以上全部
```

覆盖率（当前）：语句 86.9%、分支 80.8%、函数 85.8%、行 89.4%。

测试分层：
- **纯逻辑**（`src/shared`）：布局、变换、筛选、手势、i18n — 无 IO，可直接断言。
- **主进程**（`src/main`）：真实临时目录 + 真实 JPEG，覆盖扫描、EXIF、缩略图、协议安全、文件监听。
- **渲染层**（`src/renderer`）：React Testing Library，覆盖组件、reducer、拖拽缩放 hook。
- **端到端**（`tests/e2e`）：启动真实 Electron，走完整 IPC + 协议 + sharp 链路。

### 用真实照片库校验

```bash
npm run verify:library -- "D:\你的照片目录"
```

输出 EXIF 识别率、日期范围和耗时。不会修改任何文件。

## 项目结构

```
src/
├─ main/              主进程
│  ├─ index.ts        窗口与生命周期
│  ├─ ipc.ts          PhotoLibrary：扫描、监听、缩略图队列
│  ├─ metadata.ts     EXIF 与尺寸解析
│  ├─ scanner.ts      目录扫描
│  ├─ thumbnails.ts   sharp 缩略图生成
│  ├─ watcher.ts      fs.watch 封装
│  ├─ protocol.ts     pic:// 协议（安全边界）
│  ├─ settings-store.ts
│  └─ paths.ts        便携数据目录
├─ preload/           contextBridge 白名单 API
├─ renderer/          React 界面
│  ├─ components/     Toolbar / Wall / Tile / Viewer / FilterPanel / SortPicker
│  │                  HistoryMenu / Scrollbar / InfoPanel / AboutDialog / Logo
│  ├─ hooks/          useWall（状态编排）、usePanZoom（手势）、useFileDrop（拖入）
│  ├─ state/          wallReducer（纯 reducer）
│  └─ i18n/           语言上下文
└─ shared/            主进程与渲染层共用
   ├─ layout.ts       三种布局算法
   ├─ transform.ts    平移缩放数学（含边界钳制）
   ├─ cull.ts         视口裁剪 + 滚动目标预取
   ├─ scrollbar.ts    滚动条几何与日期映射
   ├─ keyboard.ts     键盘平移与方向键选择
   ├─ reanchor.ts     重排后保持视觉中心
   ├─ history.ts      最近文件夹的去重与上限
   ├─ filters.ts      筛选逻辑（含通配符匹配）
   ├─ gesture.ts      点击与拖拽判定
   └─ i18n/           消息目录与语言注册表
```

## 快捷键

| 场景 | 按键 | 作用 |
|------|------|------|
| 照片墙 | `←/→/↑/↓` | 平移画布 |
| 照片墙 | `Shift` + 方向键 | 大幅平移 |
| 照片墙（已选中照片） | `Alt` + 方向键 | 在照片之间移动焦点，必要时自动滚动 |
| 滚动条 | `Home` / `End` | 跳到顶部 / 底部 |
| 滚动条 | `PageUp` / `PageDown` | 向上 / 向下翻一屏 |
| 查看页 | `←/→` | 上一张 / 下一张 |
| 查看页 | `+` / `-` | 缩放 |
| 查看页 | `R`、`]`、`[` | 旋转 |
| 查看页 | `I` | 展开 / 收起 EXIF 详情 |
| 查看页 | `0` | 复位（关掉缩放与旋转） |
| 查看页 | `Esc` | 关闭（保留选中态） |

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

## 数据位置

便携版在 exe 同级创建 `PhotoStreamData/`：

| 文件 | 内容 |
|------|------|
| `settings.json` | 布局、排序、筛选、上次文件夹、语言 |
| `metadata.db` | 已解析的 EXIF 元数据缓存（SQLite，可安全删除） |
| `thumbs/` | 缩略图缓存（可安全删除，会重新生成） |

删除整个 `PhotoStreamData/` 即可恢复初始状态。

## 已知限制

- **仅 JPEG**。HEIC 需要额外解码器（sharp 预编译版不含），RAW 需要专门库；`isSupportedImage` 是唯一需要改动的地方。
- **仅 Windows**。文件监听用了 `fs.watch` 的 `recursive` 选项，Linux 不支持。
- **EXIF 早于 1900 年**的日期被视为无效（多为占位符或损坏数据）。
- 单张查看按完整原图解码，7952×5304 约需 0.55 秒；期间显示缓存的缩略图。
