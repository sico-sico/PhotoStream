# PhotoStream

A desktop photo wall for your local photo folders. Portable, offline, writes nothing to the registry.

![Electron](https://img.shields.io/badge/Electron-44-47848f) ![React](https://img.shields.io/badge/React-19-61dafb) ![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6) ![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078d4)

[中文](./README.md) | English

PhotoStream lays out the JPEGs in a folder as a wall you can drag and zoom, for browsing and finding photos. It does not build a library and does not touch your files.

Open a folder and a few thousand photos appear on one endless canvas, ordered by EXIF capture time. Drag, zoom, jump to a particular month, or filter down to a date range. Click a photo to open it full-size, then press `←/→` to walk through the rest. When you want to look at something without choosing, switch to the random show and let it cycle for you.

Browsing is all it does. It does not import, organise, tag, or edit non-destructively, and it is not a replacement for Lightroom or digiKam. Parsed metadata and thumbnails are cached in `PhotoStreamData/` next to the exe; delete that folder and the app is back to a clean state. Original photos are read, never written.

Scale shaped most of the design. On a test library of 3,226 photos (42.5 GB): about 1.9 s to open the first time, about 107 ms to reopen once metadata is cached, and a steady 60 fps while dragging (17 ms median frame time, no frames over budget). These are measured numbers; the reasoning behind them is in [architecture.md](./docs/architecture.md).

The stack is Electron, React and TypeScript. Image decoding is left to Chromium; thumbnails are generated ahead of time in the main process by `sharp` at two WebP sizes (512 and 2560), so the renderer only positions and transforms them.

Technical detail lives in [`docs/`](./docs/): [architecture.md](./docs/architecture.md) covers the implementation and its trade-offs, [research.md](./docs/research.md) has the measurements taken before the choices were made.

## Contents

- [PhotoStream](#photostream)
  - [Contents](#contents)
  - [Why use it](#why-use-it)
  - [Install and run](#install-and-run)
  - [Build from source](#build-from-source)
    - [Continuous integration](#continuous-integration)
  - [Features](#features)
  - [Usage](#usage)
  - [Keyboard shortcuts](#keyboard-shortcuts)
  - [Data and cache](#data-and-cache)
  - [Known limitations](#known-limitations)
  - [License](#license)
  - [About the author](#about-the-author)

## Why use it

A file manager is fine for a few dozen photos; at a few thousand you are scrolling a list of thumbnails. PhotoStream takes a different approach:

- Order by capture time, not file name. Camera file names (`DSC_0421.JPG`) carry no information.
- Lay the whole wall out at once and move around it by dragging and zooming, instead of paging.
- Designed for a few thousand photos; see the numbers above.
- Non-invasive. No moving, renaming or modifying photos, and all caches sit next to the exe.

Good for: skimming a trip you just finished, finding a particular month across several years, showing a client a whole batch. Not for: rating and culling, batch renaming, exporting at different sizes. Use a photo manager for those.

## Install and run

Download `PhotoStream-0.1.1-portable-win-x64.zip` from [Releases](https://github.com/sico-sico/PhotoStream/releases), unzip it, and run `PhotoStream.exe`. No installation.

The app writes its data to `PhotoStreamData/` beside the exe, so the whole folder can be moved elsewhere or onto a USB drive.

## Build from source

```bash
npm install          # Node >= 22.12 (developed on Node 24 LTS)
npm run dev          # development mode
npm run dist         # package the portable build into release/
npm run verify       # typecheck + coverage + end-to-end tests
```

`npm run dist` produces `release/PhotoStream-portable-win-x64/`.

Other scripts:

| Command | Purpose |
|------|------|
| `npm run build` | Compile only, no packaging |
| `npm run test` | Unit and integration tests |
| `npm run test:coverage` | Unit tests with coverage (70% floor) |
| `npm run test:e2e` | Build, then run the Playwright end-to-end tests |
| `npm run verify:library -- "D:\photos"` | Run parsing and statistics against a real photo library |
| `npm run icon` | Regenerate `icon.ico` / `icon.png` from `build/icon.svg` |

To change the app icon, edit `build/icon.svg` and run `npm run icon` (it generates 16/24/32/48/64/128/256).

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: typecheck, coverage tests, end-to-end tests, all on `windows-latest`. Playwright traces are uploaded on failure.

Windows only: the file watcher uses `fs.watch({ recursive: true })`, which Node supports on Windows and macOS but not Linux, and several tests assert on `D:\...` literals, so a Linux failure would have nothing to do with the change.

`.github/workflows/release.yml` is triggered by a tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

It re-runs typecheck and the unit tests, packages the build, then launches the packaged exe through `smoke:portable` to check asar path resolution, the unpacked native modules and the `pic://` protocol, and finally attaches the zip to a GitHub Release.

Electron 44 has no `postinstall` and downloads its runtime lazily. Both workflows run `npx install-electron` explicitly; otherwise that 100 MB download happens in the middle of the e2e step, where a slow one looks like a test timeout.

## Features

| | |
|---|---|
| Photo wall | Reads the JPEGs in a folder, ordered by EXIF capture time (newest first by default). Drag in any direction, `Ctrl` + wheel zooms around the cursor, bare wheel pans. |
| Vertical scrollbar | Proportional positioning; the destination date is shown beside the thumb while dragging; supports `Home`/`End`/`PageUp`/`PageDown`. |
| Drop to open | Drop a folder or any single photo anywhere on the window. |
| Open one photo | Drop a photo, or pass a file on the command line: opens its folder, zooms to it, and expands the EXIF panel. |
| Recent folders | Remembers the last 12 folders, reopenable from the dropdown beside "Open folder", individually or all at once removable. |
| Subfolders | "Include photos in subfolders" in the gear menu, off by default. Scans recursively, skipping hidden directories and caches like `node_modules`. |
| Ring size | Sets how many photos surround the centre in the random show (30–90, default 70), applied as you drag. It is a ceiling on candidates, not a promise: the scatter still drops what does not fit, so 90 candidates place about 63 cards at 2560×1440. |
| Three layouts | Equal-height rows (aspect preserved), masonry (aspect preserved), square grid. |
| Sorting | Newest / oldest / name A→Z / name Z→A, remembered. |
| Filtering | Date range (from EXIF) plus file name. `*` and `?` wildcards are supported; without a wildcard it is a substring match. |
| Single-photo viewer | Shows the cached thumbnail first and swaps in the full image once decoded; wheel/pinch zoom, drag to pan, rotate, `←/→` to step, `Esc` to close, `I` to toggle EXIF. The panel's open state is remembered. |
| File watching | Photos added, overwritten or deleted show up on the wall immediately, no need to reopen the folder. |
| Languages | 中文（简体）, English, Français. Follows the system by default, switchable at runtime, and third-party languages can be injected. |
| Frameless window | Custom title bar and window buttons; drag the window from empty toolbar space. |
| Random show | Goes fullscreen: one photo centred, ringed by smaller ones of varying size with 3D tilt, lighting and paper thickness. Promotes a neighbour every 8 s and deals a fresh ring every 60 s; the outgoing ring drops out of the bottom of the window. Click a small photo to bring it to the centre; hovering pauses. `Esc` exits and restores the window. |
| About dialog | Version, runtime versions, data directory, shortcuts and repository link, from the gear menu. |
| Portable | All data lives in `PhotoStreamData/` beside the exe, and the folder can be moved freely. |

## Usage

**Open a folder**

Click "Open folder" at the top left, or drop a folder onto the window. The last folder reopens on the next launch.

**Jump to a month**

Drag the scrollbar on the right; the destination date appears beside the thumb. `Home`/`End`/`PageUp`/`PageDown` also work.

**Show only a date range or certain files**

Click "Filters". File names accept wildcards: `IMG_*.jpg` matches every file starting with `IMG_`, and `2018-02-0?` matches the 1st through the 9th.

**Browse at random**

Click "Random show" in the toolbar. It goes fullscreen with one photo enlarged at the centre and a scatter of smaller ones around it. Left alone it promotes one of the surrounding photos every 8 seconds and deals a whole new batch every minute; click a photo to keep it. Whatever the pointer rests on, the show holds still.

On a turnover the old ring falls out of the bottom of the window together and the new batch drops into place. The centre photo is unaffected and carries over between batches.

The random show uses the current filters, so you can narrow to a date range first. Exit with `Esc` or the button at the top right; the window returns to its previous state (still fullscreen if it was).

How many photos surround the centre is set in the gear menu under "Photos around the centre in the random show" (30–90, default 70). Dragging the slider re-deals immediately rather than waiting for a turnover.

**Open a single photo**

Three equivalent ways, all of which open the containing folder, zoom to the photo and expand EXIF:

1. Drop the photo file onto the window;
2. `PhotoStream.exe D:\photos\IMG_0001.jpg` on the command line;
3. After registering as described below, right-click → "Open with" → PhotoStream.

If the app is already running, 2 and 3 are handed to the existing window instead of starting a second instance.

**Register as a system "Open with" handler**

The app writes nothing to the registry, which is what keeps it portable. Add a ProgID yourself if you want this (substitute your actual path):

```powershell
$exe = 'D:\Apps\PhotoStream\PhotoStream.exe'
$key = 'HKCU:\Software\Classes\PhotoStream.jpg'

New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'PhotoStream photo viewer'
Set-ItemProperty -Path $key -Name 'DefaultIcon' -Value "$exe,0" -ErrorAction SilentlyContinue
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value "`"$exe`" `"%1`""

# Add it to the "Open with" candidates for .jpg
New-ItemProperty -Path 'HKCU:\Software\Classes\.jpg\OpenWithProgids' `
  -Name 'PhotoStream.jpg' -PropertyType None -Value '' -Force | Out-Null
```

After that, right-click a `.jpg` → "Open with" → "Choose another app" and PhotoStream will be listed. To undo it, delete `HKCU:\Software\Classes\PhotoStream.jpg` and that one value under `.jpg\OpenWithProgids`; nothing else is affected.

## Keyboard shortcuts

| Context | Keys | Action |
|------|------|------|
| Wall | `←/→/↑/↓` | Pan the canvas |
| Wall | Wheel / trackpad two-finger | Pan the canvas (`Shift` + wheel for horizontal) |
| Wall | `Ctrl` + wheel | Zoom around the cursor |
| Wall | `Shift` + arrow | Pan a larger step |
| Wall (photo selected) | `Alt` + arrow | Move focus between photos, scrolling as needed |
| Wall (photo selected) | `Enter` / `Space` | Open the selected photo |
| Scrollbar | `Home` / `End` | Jump to top / bottom |
| Scrollbar | `PageUp` / `PageDown` | Page up / down |
| Viewer | `←/→` | Previous / next photo |
| Viewer | `+` / `-` | Zoom |
| Viewer | `R`, `]`, `[` | Rotate |
| Viewer | `I` | Show / hide EXIF details |
| Viewer | `0` | Reset (clear zoom and rotation) |
| Viewer | `Esc` | Close (keeps the selection) |
| Random show | Click a small photo | Bring it to the centre |
| Random show | Hover a small photo | Pause automatic changes |
| Random show | `Esc` | Exit and restore the window |

## Data and cache

The portable build creates `PhotoStreamData/` beside the exe:

| File | Contents | Safe to delete |
|------|------|--------|
| `settings.json` | Layout, sort, filters, last folder, language, recent folders, recursion, EXIF panel, random show ring size | Resets settings |
| `metadata.db` | Parsed EXIF (SQLite) | Re-parsed; the first open is slower |
| `thumbs/` | Thumbnail cache (WebP) | Regenerated |

Deleting the whole `PhotoStreamData/` restores the initial state. The photos themselves are never modified.

## Known limitations

- JPEG only. HEIC needs an extra decoder (the prebuilt sharp does not include one) and RAW needs a dedicated library.
- Windows x64 only. File watching relies on `fs.watch` with `recursive`, which Linux does not support.
- Nothing is written to the registry, so the app does not appear in the right-click "Open with" menu by default; see [above](#usage) to add it.
- EXIF dates before 1900 are treated as invalid (usually placeholders or corrupt data).
- The viewer decodes the full image, about 0.55 s for 7952×5304, showing the cached thumbnail meanwhile.
- Zooming out stops at a floor. Any further and the wall would not fill the window, and photos would exceed the render limit and disappear. The floor adjusts with library size.
- Defender gets busy for a while when opening a folder. The app starts no processes; real-time protection is scanning our reads (a 512 KB EXIF prefix per file). Once the cache is warm no files are read and the activity stops. See [architecture.md](./docs/architecture.md).
- No tree browsing of nested folders. Recursion simply merges subfolder files onto the same wall.

## License

MIT

## About the author

The code is written by [GitHub Copilot](https://github.com/features/copilot) (DeepSeek V4 Flash model). Requirements, trade-offs and acceptance are decided by [sico-sico](https://github.com/sico-sico).
