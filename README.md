# PhotoStream

桌面照片墙：自由拖动、滚轮缩放、可折叠筛选、单张查看。便携版，无需安装。

![Electron](https://img.shields.io/badge/Electron-44-blue) ![React](https://img.shields.io/badge/React-19-61dafb) ![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)

## 功能

- **照片墙**：读取一个文件夹的 JPEG，按 EXIF 拍摄时间排序，任意方向拖动，滚轮以光标为锚点缩放。
- **三种布局**：等高行（保留比例）、瀑布流（保留比例）、正方形网格。
- **筛选**：日期范围（来自 EXIF）+ 文件名关键字，默认显示全部。
- **单张查看**：先显示缓存缩略图，原图解码完成后无感替换；`←/→` 翻页，`Esc` 关闭。
- **文件监听**：新增、覆盖、删除照片都会实时反映到墙上，无需重新打开文件夹。
- **多语言**：中文（简体）、English、Français，默认跟随系统语言，可运行时切换。
- **便携**：所有数据写在 exe 同级的 `PhotoStreamData/`，整个目录可随意移动。

## 快速开始

```bash
npm install          # 需要 Node >= 22.12
npm run dev          # 开发模式
npm run dist         # 打包绿色版到 release/
```

`npm run dist` 产出 `release/PhotoStream-portable-win-x64/`，运行其中的 `PhotoStream.exe` 即可。

## 技术选型

| 方面 | 选择 | 原因 |
|------|------|------|
| 运行时 | Electron 44（Chromium 152 / Node 24） | 图像处理生态成熟，前端开发效率高 |
| 缩略图 | `sharp`（libvips） | 实测 512px WebP 约 1.2 ms/张，比 `nativeImage.createThumbnailFromPath` 快 5.5 倍、体积小 10 倍 |
| EXIF | `sharp.metadata()` + `exif-reader` | `exif-reader` 零依赖且仍在维护；`exifr` 已 4.5 年未更新 |
| 画布 | 单容器 CSS `transform` | 3226 个瓦片实测稳定 16.7 ms/帧（60 fps），无需 Canvas 库 |
| 文件监听 | Node 内置 `fs.watch` | 少一个依赖，避开 ESM/CJS 问题；本应用只面向 Windows |
| 打包 | `@electron/packager` | `electron-builder` 会引入 8 个已知漏洞和 4 个弃用包 |

详细的实测数据见 [`research.md`](./research.md)。

## 关键实现细节

这些是踩过的坑，改动相关代码前值得先读。

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
npm run test             # 405 个单元/集成测试
npm run test:coverage    # 覆盖率门槛：70%
npm run test:e2e         # 12 个 Playwright 端到端测试
npm run verify           # 以上全部
```

覆盖率（当前）：语句 93.5%、分支 89.6%、函数 90.6%、行 95.6%。

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
│  ├─ components/     Toolbar / Wall / Tile / Viewer / FilterPanel
│  ├─ hooks/          useWall（状态编排）、usePanZoom（手势）
│  ├─ state/          wallReducer（纯 reducer）
│  └─ i18n/           语言上下文
└─ shared/            主进程与渲染层共用
   ├─ layout.ts       三种布局算法
   ├─ transform.ts    平移缩放数学
   ├─ filters.ts      筛选逻辑
   ├─ gesture.ts      点击与拖拽判定
   └─ i18n/           消息目录与语言注册表
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

## 数据位置

便携版在 exe 同级创建 `PhotoStreamData/`：

| 文件 | 内容 |
|------|------|
| `settings.json` | 布局、筛选、上次文件夹、语言 |
| `thumbs/` | 缩略图缓存（可安全删除，会重新生成） |

删除整个 `PhotoStreamData/` 即可恢复初始状态。

## 已知限制

- **仅 JPEG**。HEIC 需要额外解码器（sharp 预编译版不含），RAW 需要专门库；`isSupportedImage` 是唯一需要改动的地方。
- **仅 Windows**。文件监听用了 `fs.watch` 的 `recursive` 选项，Linux 不支持。
- **EXIF 早于 1900 年**的日期被视为无效（多为占位符或损坏数据）。
- 单张查看按完整原图解码，7952×5304 约需 0.55 秒；期间显示缓存的缩略图。
