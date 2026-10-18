# PhotoStream

一个面向本地照片目录的桌面照片墙。便携、离线、不写注册表。

![Electron](https://img.shields.io/badge/Electron-44-47848f) ![React](https://img.shields.io/badge/React-19-61dafb) ![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6) ![平台](https://img.shields.io/badge/平台-Windows%20x64-0078d4)

PhotoStream 把一个文件夹的 JPEG 铺成一面可以自由拖动、缩放的墙，用来快速浏览和定位，而不是编辑或管理照片。它不建库、不改原文件、不移动照片。

技术内容在 [`docs/`](./docs/)：架构与实现取舍见 [architecture.md](./docs/architecture.md)，选型前的实测数据见 [research.md](./docs/research.md)。

## 目录

- [PhotoStream](#photostream)
  - [目录](#目录)
  - [为什么用它](#为什么用它)
  - [安装与运行](#安装与运行)
  - [从源码构建](#从源码构建)
    - [持续集成](#持续集成)
  - [功能](#功能)
  - [怎么用](#怎么用)
  - [快捷键](#快捷键)
  - [数据与缓存](#数据与缓存)
  - [已知限制](#已知限制)
  - [许可](#许可)
  - [关于作者](#关于作者)

## 为什么用它

普通文件管理器看几十张照片还行，几千张就只能靠缩略图列表。PhotoStream 的取舍是：

- **按拍摄时间而不是文件名组织**，因为相机文件名（`DSC_0421.JPG`）没有信息量。
- **整面墙一次性铺开**，靠拖动和缩放浏览，而不是翻页或列表。
- **为几千张的规模设计**。3226 张时拖动稳定在 60 fps；首次打开约 1.9 秒，再次打开约 **107 ms**（元数据已缓存）。
- **不侵入**。不移动、不重命名、不修改照片；所有缓存都在 exe 旁边，删掉即恢复原状。

## 安装与运行

下载或解压 `PhotoStream-portable-win-x64/`，双击其中的 `PhotoStream.exe` 即可，无需安装。

应用会把数据写在自己旁边的 `PhotoStreamData/` 目录里，整个文件夹可以随意移动到别的位置或 U 盘。

## 从源码构建

```bash
npm install          # Node >= 22.12（开发使用 Node 24 LTS）
npm run dev          # 开发模式
npm run dist         # 打包绿色版到 release/
npm run verify       # typecheck + 覆盖率测试 + 端到端测试
```

`npm run dist` 产出 `release/PhotoStream-portable-win-x64/`。

其他脚本：

| 命令 | 作用 |
|------|------|
| `npm run build` | 只编译，不打包 |
| `npm run test` | 单元/集成测试 |
| `npm run test:coverage` | 单元测试 + 覆盖率（门槛 70%） |
| `npm run test:e2e` | 编译后运行 Playwright 端到端测试 |
| `npm run verify:library -- "D:\照片目录"` | 用真实照片库跑一遍解析与统计 |
| `npm run icon` | 由 `build/icon.svg` 重新生成 `icon.ico` / `icon.png` |

修改应用图标：编辑 `build/icon.svg`，然后运行 `npm run icon`（生成 16/24/32/48/64/128/256 各尺寸）。

### 持续集成

`.github/workflows/ci.yml` 在每次推送到 `main` 和每个 PR 上运行，全部在 `windows-latest` 上：类型检查 → 覆盖率测试（70% 门槛）→ 端到端测试。失败时上传 Playwright 的 trace。

只跑 Windows 是有原因的：文件监听用 `fs.watch({ recursive: true })`（Node 仅 Windows/macOS 支持），且测试里有 `D:\...` 字面量，在 Linux 上失败的原因与改动无关。

`.github/workflows/release.yml` 由 tag 触发：

```bash
git tag v0.2.0
git push origin v0.2.0
```

它会重新跑类型检查、单元测试与打包，然后用 `npm run smoke:portable` **启动打包好的 exe** 验证 asar 路径、解包的原生模块和 `pic://` 协议，最后把 zip 附到 GitHub Release。

> Electron 44 没有 `postinstall` 脚本，运行时会懒下载。两个 workflow 都显式执行了 `npx install-electron`，把这次约 100 MB 的下载从测试步骤里挪出来 —— 否则它会在 e2e 中途发生，慢的时候看起来像测试超时。

## 功能

| | |
|---|---|
| **照片墙** | 读取一个文件夹的 JPEG，按 EXIF 拍摄时间排序（默认最新在前），任意方向拖动，`Ctrl` + 滚轮以光标为锚点缩放，裸滚轮平移。 |
| **竖向滚动条** | 按比例定位；拖动时在滑块旁显示落点日期；支持 `Home`/`End`/`PageUp`/`PageDown`。 |
| **拖入打开** | 把文件夹或任意一张照片拖到窗口任意位置即可打开。 |
| **单张放大** | 拖入一张照片，或从命令行传入一个文件：打开它所在的文件夹、放大它，并展开 EXIF 详情。 |
| **最近文件夹** | 记住最近 12 个打开过的文件夹，可从「打开文件夹」右侧的下拉里重新打开，也可删除单条或全部清除。 |
| **子文件夹** | 齿轮菜单里的「包含子文件夹中的照片」，默认关闭。开启后递归扫描，跳过隐藏目录与 `node_modules` 一类缓存目录。 |
| **环绕数量** | 齿轮菜单里调随机播放的环绕张数（30–90，默认 70），拖动即时生效。这个数字是**候选上限**：散点布局放不下的仍然会被丢掉，2560×1440 下 90 个候选实际能放下约 63 张。 |
| **三种布局** | 等高行（保留比例）、瀑布流（保留比例）、正方形网格。 |
| **排序** | 最新优先 / 最早优先 / 名称 A→Z / 名称 Z→A，选择会被记住。 |
| **筛选** | 日期范围（来自 EXIF）+ 文件名匹配。文件名支持通配符 `*` 与 `?`；不含通配符时按「包含」匹配。 |
| **单张查看** | 先显示缓存缩略图，原图解码完成后无感替换；滚轮/双指缩放、拖拽平移、旋转、`←/→` 翻页、`Esc` 关闭；`I` 展开 EXIF 详情。面板是否展开会被记住，翻页与重启都不丢。 |
| **文件监听** | 新增、覆盖、删除照片都会实时反映到墙上，无需重新打开文件夹。 |
| **多语言** | 中文（简体）、English、Français。默认跟随系统语言，可运行时切换，也可注入第三方语言。 |
| **无边框窗口** | 自绘标题栏与窗口按钮；工具栏空白处拖动窗口。 |
| **随机播放** | 进入后自动全屏：一张照片居中，周围漂浮一圈大小不一的照片（带 3D 倾斜、光影与相纸厚度）。每 8 秒换一张居中、每 60 秒换一批，换批时旧的一整圈从窗口下方掉落；点任意小图可将它居中；悬停小图时暂停。按 `Esc` 退出并还原窗口。 |
| **关于对话框** | 齿轮菜单里查看版本、运行时版本、数据目录、快捷键与仓库地址。 |
| **便携** | 所有数据写在 exe 同级的 `PhotoStreamData/`，整个目录可随意移动。 |

## 怎么用

**打开一个文件夹**

点左上角「打开文件夹」，或把文件夹拖到窗口里。下次启动会自动打开上次的文件夹。

**快速跳到某个月**

拖右侧滚动条，滑块旁会显示落点日期；也可以用 `Home`/`End`/`PageUp`/`PageDown`。

**只看某个日期段或某些文件**

点「筛选」。文件名支持通配符：`IMG_*.jpg` 匹配所有 `IMG_` 开头的文件，`2018-02-0?` 匹配 1 到 9 号。

**随便翻翻**

点工具栏的「随机播放」。它会切到全屏，把一张照片放大居中，周围散落一圈大小不一的照片。放着不管，它每隔 8 秒把周围的一张升为居中、每分钟换一整批；想留住某张就点它。鼠标停在哪张小图上，画面就停住不动。

换批的时候，旧的那一圈照片会从窗口下方一起掉出去，新的一批随即落下就位。居中那张不受影响，它会跨批次留着。

随机播放使用当前的筛选结果，所以可以先筛出某个日期段再随机看。退出按 `Esc` 或右上角的按钮，窗口会恢复成原来的状态（原本全屏就仍是全屏）。

周围照片的多少可以在齿轮菜单里用「随机播放中环绕居中的照片数」调节（30–90，默认 70）。拖动滑杆时画面立即重排，不用等换批；数量多则更满，少则留白更多。

**打开单张照片**

三种方式等价，都会打开所在文件夹、放大该照片并展开 EXIF：

1. 把照片文件拖到窗口里；
2. 命令行 `PhotoStream.exe D:\photos\IMG_0001.jpg`；
3. 事先按下方说明注册后，右键 →「打开方式」→ PhotoStream。

应用已在运行时，2 和 3 会转交给现有窗口，不会开第二个实例。

**设为系统「打开方式」**

应用本身不写注册表，这是保持便携的前提。需要的话自行添加 ProgID（把路径换成实际位置）：

```powershell
$exe = 'D:\Apps\PhotoStream\PhotoStream.exe'
$key = 'HKCU:\Software\Classes\PhotoStream.jpg'

New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'PhotoStream 照片查看器'
Set-ItemProperty -Path $key -Name 'DefaultIcon' -Value "$exe,0" -ErrorAction SilentlyContinue
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""

# 挂到 .jpg 的「打开方式」候选列表
New-ItemProperty -Path 'HKCU:\Software\Classes\.jpg\OpenWithProgids' `
  -Name 'PhotoStream.jpg' -PropertyType None -Value '' -Force | Out-Null
```

之后右键某个 `.jpg` →「打开方式」→「选择其他应用」即可看到 PhotoStream。卸载时删除 `HKCU:\Software\Classes\PhotoStream.jpg` 及 `.jpg\OpenWithProgids` 下那一条，不影响其他设置。

## 快捷键

| 场景 | 按键 | 作用 |
|------|------|------|
| 照片墙 | `←/→/↑/↓` | 平移画布 |
| 照片墙 | 滚轮 / 触控板双指 | 平移画布（`Shift` + 滚轮横向） |
| 照片墙 | `Ctrl` + 滚轮 | 以光标为锚点缩放 |
| 照片墙 | `Shift` + 方向键 | 大幅平移 |
| 照片墙（已选中照片） | `Alt` + 方向键 | 在照片之间移动焦点，必要时自动滚动 |
| 照片墙（已选中照片） | `Enter` / `Space` | 打开选中的照片 |
| 滚动条 | `Home` / `End` | 跳到顶部 / 底部 |
| 滚动条 | `PageUp` / `PageDown` | 向上 / 向下翻一屏 |
| 查看页 | `←/→` | 上一张 / 下一张 |
| 查看页 | `+` / `-` | 缩放 |
| 查看页 | `R`、`]`、`[` | 旋转 |
| 查看页 | `I` | 展开 / 收起 EXIF 详情 |
| 查看页 | `0` | 复位（关掉缩放与旋转） |
| 查看页 | `Esc` | 关闭（保留选中态） |
| 随机播放 | 点小图 | 把它升为居中 |
| 随机播放 | 悬停小图 | 暂停自动切换 |
| 随机播放 | `Esc` | 退出并还原窗口 |

## 数据与缓存

便携版在 exe 同级创建 `PhotoStreamData/`：

| 文件 | 内容 | 可删除 |
|------|------|--------|
| `settings.json` | 布局、排序、筛选、上次文件夹、语言、最近文件夹、是否递归、EXIF 详情面板、随机播放环绕数量 | 会重置设置 |
| `metadata.db` | 已解析的 EXIF（SQLite） | 会重新解析，首次打开变慢 |
| `thumbs/` | 缩略图缓存（WebP） | 会重新生成 |

删除整个 `PhotoStreamData/` 即可恢复初始状态。照片本身从不被修改。

## 已知限制

- **仅 JPEG**。HEIC 需要额外解码器（sharp 预编译版不含），RAW 需要专门库。
- **仅 Windows x64**。文件监听依赖 `fs.watch` 的 `recursive` 选项，Linux 不支持。
- **不写注册表**，因此默认不会出现在右键「打开方式」里，需按[上文](#怎么用)手动添加。
- **EXIF 早于 1900 年**的日期被视为无效（多为占位符或损坏数据）。
- **单张查看按完整原图解码**，7952×5304 约需 0.55 秒；期间显示缓存的缩略图。
- **不能无限缩小**。缩到一定程度就停下，因为再小墙面就填不满窗口、也会有照片超出渲染上限而消失。下限随图库规模自动调整。
- **打开文件夹时 Defender 会繁忙一段**。应用不启动任何进程，是实时保护在扫描我们对每个文件的读取（每张照片读 512 KB 的 EXIF 前缀）。缓存命中后不再读文件，现象随之消失。详见 [architecture.md](./docs/architecture.md)。
- **没有嵌套文件夹的树形浏览**：递归只是把子目录的文件并入同一面墙。

## 许可

MIT

## 关于作者

这个仓库的代码全部由 AI 编写：[GitHub Copilot](https://github.com/features/copilot)，使用 **DeepSeek V4 Flash** 模型。需求、取舍与验收由 [sico-sico](https://github.com/sico-sico) 决定。

