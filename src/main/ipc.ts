import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { basename, relative as relativePath, sep } from 'node:path'
import type { AppInfo, Photo, ScanResult, Settings, ThumbLevel } from '../shared/types'
import { IPC } from '../shared/ipc'
import { scanDirectory } from './scanner'
import { resolveOpenTarget } from './drop'
import type { OpenDroppedResult } from '../shared/types'
import { ensureThumbnail, ensureThumbnails, type ThumbRequest } from './thumbnails'
import type { ThumbPriority } from '../shared/types'
import { loadSettings, saveSettings } from './settings-store'
import { watchDirectory, type DirectoryWatcher, type RawWatchEvent } from './watcher'
import { thumbUrl, photoUrl } from './protocol'
import { findPhoto, removePhoto, sortPhotos, upsertPhoto } from '../shared/photoStore'
import { readImageMetadata, readFullExif } from './metadata'
import type { MetadataCache } from './metadata-cache'
import type { RawExif } from '../shared/exif'
import { locales } from '../shared/i18n'

/**
 * Owns the currently open library: scanning, watching, thumbnail warm-up and
 * the notifications the renderer listens to.
 */
export class PhotoLibrary {
  private photos: Photo[] = []
  private dir = ''
  private watcher: DirectoryWatcher | null = null
  private thumbQueue: Promise<unknown> = Promise.resolve()
  /**
   * Incremented for every `open()`. A scan only applies its result if its token
   * is still the newest, which is what stops a slow folder from overwriting a
   * faster one the user opened after it.
   */
  private generation = 0
  /** Abort controller for the scan currently in flight, if any. */
  private scanning: AbortController | null = null
  /**
   * Signals of each scan, in the order they were started.
   *
   * Exposed for tests: an abandoned scan must be aborted, not merely ignored, or
   * dropping three folders reads EXIF for two libraries nobody will ever see.
   */
  readonly scanSignals: AbortSignal[] = []

  constructor(
    readonly thumbCacheDir: string,
    private readonly notify: (channel: string, payload: unknown) => void,
    /** Cache of parsed EXIF, keyed by path + mtime + size. */
    readonly metadataCache?: MetadataCache
  ) {}

  get directory(): string {
    return this.dir
  }

  get all(): readonly Photo[] {
    return this.photos
  }

  /**
   * Whether subfolders are scanned, and whether watcher events below the root
   * are honoured. Set on each `open()` so switching the preference and
   * re-opening the same folder takes effect.
   */
  private recursive = false

  /**
   * Claim the right to open the library.
   *
   * Called *before* anything that awaits. Resolving a dropped path does a
   * `stat`, which can be slow on a sleeping drive or a network share; claiming
   * afterwards made the token follow the order the `stat` calls finished rather
   * than the order the user dropped the folders, so dropping A then B could end
   * up showing A.
   *
   * Aborts whatever scan was already running: the user has moved on, and reading
   * metadata for a library nobody will see is pure waste.
   */
  claim(): { generation: number; signal: AbortSignal } {
    this.scanning?.abort()
    const controller = new AbortController()
    this.scanning = controller
    this.scanSignals.push(controller.signal)
    return { generation: ++this.generation, signal: controller.signal }
  }

  /**
   * Open a directory: scan it, start watching, and warm thumbnails in the
   * background.
   *
   * @param options.generation from `claim`, when the caller awaited something
   *   before getting here. Omit it to claim now.
   */
  async open(
    dir: string,
    options: { recursive?: boolean; generation?: number; signal?: AbortSignal } = {}
  ): Promise<ScanResult> {
    // Claiming here keeps every caller that has nothing to await working. The
    // drop handler passes its own generation instead, because its token has to
    // predate the `stat` it already awaited.
    const claim = options.generation === undefined ? this.claim() : null
    const generation = claim?.generation ?? options.generation!
    const signal = claim?.signal ?? options.signal

    this.close()
    this.recursive = options.recursive === true

    const result = await scanDirectory(dir, {
      cache: this.metadataCache,
      recursive: this.recursive,
      signal
    })

    // A later open has already taken over: this result is for a folder the user
    // moved on from. Discarding it is what makes "the last folder you dropped"
    // the one you actually see, regardless of which scan finishes first.
    if (generation !== this.generation) return result

    // Only the winner clears the in-flight scan, so a stale open cannot make a
    // newer one look finished.
    if (signal?.aborted !== true) this.scanning = null
    this.photos = result.photos
    this.dir = result.dir
    // `close()` above detached the previous watcher; start the new one only
    // once this scan is the winner, or an abandoned folder keeps a recursive
    // watch open for the rest of the session.
    this.watcher = this.startWatching(result.dir)
    // No eager warm-up here. Generating renditions for every file made a large
    // folder take minutes before the wall felt usable, and most of those
    // thumbnails were never looked at. The renderer asks for what is on screen
    // instead, so work scales with what the user actually sees.
    return { dir: result.dir, photos: result.photos, skipped: result.skipped, durationMs: result.durationMs }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  /**
   * Wait for queued thumbnail work to finish.
   *
   * Thumbnail generation runs in the background so the wall can appear
   * immediately. Callers that are about to tear down state (closing the window,
   * switching libraries, or a test cleaning its temp directory) need to know
   * when that work has actually stopped touching the filesystem.
   */
  async drain(): Promise<void> {
    await this.thumbQueue.catch(() => undefined)
  }

  /**
   * `fs.watch` reports creation and deletion identically, so a `touch` event is
   * resolved by probing the filesystem at flush time.
   *
   * The result distinguishes added/changed photos from removals: a batch that
   * only deletes files yields no photos but still has to reach the renderer, or
   * the wall keeps showing thumbnails for files that are gone.
   */
  private async resolveEvents(events: readonly RawWatchEvent[]): Promise<{ touched: Photo[]; removed: boolean }> {
    const touched: Photo[] = []
    let removed = false

    for (const event of events) {
      if (event.type === 'change') {
        const refreshed = await this.refresh(event.path)
        if (refreshed) touched.push(refreshed)
        continue
      }

      // 'touch' — could be either direction.
      try {
        const info = await stat(event.path)
        if (!info.isFile()) continue
        const refreshed = await this.refresh(event.path)
        if (refreshed) touched.push(refreshed)
      } catch {
        if (findPhoto(this.photos, event.path)) {
          this.photos = removePhoto(this.photos, event.path)
          removed = true
        }
      }
    }

    if (removed) this.photos = sortPhotos(this.photos)
    return { touched, removed }
  }

  /** Re-read one file's metadata and fold it into the collection. */
  private async refresh(path: string): Promise<Photo | null> {
    try {
      const [info, meta] = await Promise.all([stat(path), readImageMetadata(path)])
      // A changed file has a new mtime/size, so any existing row no longer
      // matches. Writing the fresh parse keeps the cache useful after a
      // re-export: without it, the next launch would re-read the 512 KB prefix
      // for a photo that had just been parsed here.
      this.metadataCache?.store(path, info.mtimeMs, info.size, meta)
      const photo: Photo = {
        id: path.toLowerCase(),
        path,
        // Relative to the library root, so a recursive scan keeps the subfolder
        // in the name and two same-named photos stay distinguishable.
        name: relativeTo(this.dir, path),
        width: meta.width,
        height: meta.height,
        takenAt: meta.takenAt,
        dateSource: meta.takenAt ? 'exif' : 'none',
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size
      }
      this.photos = upsertPhoto(this.photos, photo)
      return photo
    } catch {
      return null
    }
  }

  private startWatching(dir: string): DirectoryWatcher {
    // The generation this watcher belongs to. `fs.watch` delivers events
    // asynchronously and the handler below awaits `stat` plus an EXIF read, so a
    // batch can still be in flight when the user opens a different folder. Those
    // results used to be folded into the *new* library, splicing a file from the
    // previous folder into the wall that had just been opened.
    const generation = this.generation
    return watchDirectory(dir, {
      onEvents: (events) => {
        if (generation !== this.generation) return

        // The watcher is always recursive, so it sees subfolders whether or not
        // they are part of the library. Filtering here keeps the scan and the
        // watcher consistent: with the setting off, a new file in a subfolder
        // must not appear on the wall.
        const relevant = this.recursive
          ? events
          : events.filter((event) => !relativePath(dir, event.path).includes(sep))

        if (relevant.length === 0) return
        void this.resolveEvents(relevant).then(({ touched, removed }) => {
          // Re-check after the awaits: the user can open another folder while
          // the metadata is being read.
          if (generation !== this.generation) return
          // A deletion changes the wall without producing a photo to thumbnail.
          if (touched.length === 0 && !removed) return
          // New photos need thumbnails; changed ones need theirs rebuilt.
          if (touched.length > 0) this.warmThumbnails(touched, 'wall')
          this.notify(IPC.photosChanged, { kind: 'delta', photos: this.photos })
        })
      },
      onError: (error) => {
        if (generation !== this.generation) return
        this.notify(IPC.photosChanged, { kind: 'error', message: error.message })
      }
    })
  }

  /**
   * Generate thumbnails in the background, reporting progress.
   *
   * Only meaningful for the cached levels; `full` is the original file and has
   * nothing to generate.
   */
  warmThumbnails(photos: readonly Photo[], level: ThumbLevel): void {
    if (level === 'full') return
    const requests = photos.map((photo) => toThumbRequest(photo, level))
    this.thumbQueue = this.thumbQueue.then(() =>
      ensureThumbnails(this.thumbCacheDir, requests, {
        onDone: (done, total) => this.notify(IPC.thumbProgress, { done, total })
      })
    )
  }

  /**
   * Resolve the URL for one photo at one level.
   *
   * `full` bypasses the cache entirely and streams the original, which is what
   * keeps the wall sharp at high zoom.
   *
   * `maxEdge` asks for a display-sized rendition instead of the level's fixed
   * size. The viewer uses it so the bitmap it receives matches the pixels it
   * will actually paint: a larger bitmap is downscaled again by Chromium, and
   * that second resample is the softness that made the viewer look worse than
   * the system viewer even though it was showing the full original.
   */
  async thumbUrlFor(
    photo: Photo,
    level: ThumbLevel,
    priority: ThumbPriority = 'interactive',
    maxEdge?: number
  ): Promise<string> {
    if (level === 'full') return photoUrl(relativeTo(this.dir, photo.path))
    const file = await ensureThumbnail(
      this.thumbCacheDir,
      toThumbRequest(photo, level, maxEdge),
      priority
    )
    // Relative, not `basename`: the cache is sharded into `a/b/` subdirectories,
    // and the `pic://thumb` handler resolves the path against the cache root.
    return thumbUrl(relativeTo(this.thumbCacheDir, file))
  }
}

function toThumbRequest(
  photo: Photo,
  level: Exclude<ThumbLevel, 'full'>,
  maxEdge?: number
): ThumbRequest {
  return {
    sourcePath: photo.path,
    mtimeMs: photo.mtimeMs,
    sizeBytes: photo.sizeBytes,
    level,
    maxEdge,
    // From the scan, so no extra read is needed to decide whether a `zoom`
    // rendition of this photo would hold more detail than `wall`.
    sourceWidth: photo.width,
    sourceHeight: photo.height
  }
}

/**
 * Path of `target` relative to `root`, with forward slashes.
 *
 * `pic://` URLs carry a path, not just a file name, so the protocol can serve
 * photos in subfolders of a recursively scanned library. Forward slashes are
 * used because that is what a URL path expects; `resolve()` on the other side
 * normalises them back.
 *
 * Falls back to the bare file name when `target` is not under `root`, which can
 * only happen for a stale watcher event.
 */
export function relativeTo(root: string, target: string): string {
  const relative = relativePath(root, target)
  if (!relative || relative.startsWith('..')) return basename(target)
  return relative.split(sep).join('/')
}

export interface IpcDeps {
  library: PhotoLibrary
  dataDir: string
  appVersion: string
  /** Electron and Chromium versions, for the About dialog. */
  versions: { electron: string; chromium: string }
  /** Locale tags the OS prefers, most preferred first. */
  systemLocales: string[]
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle(
    IPC.appInfo,
    (): AppInfo => ({
      version: deps.appVersion,
      dataDir: deps.dataDir,
      thumbCacheDir: deps.library.thumbCacheDir,
      systemLocales: deps.systemLocales,
      electron: deps.versions.electron,
      chromium: deps.versions.chromium
    })
  )

  // The renderer owns language resolution, so it passes the active locale along.
  // Unknown tags are harmless: `registerIpc` falls back to English.
  ipcMain.handle(IPC.pickDirectory, async (_event, locale?: string): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: locales.translator(locale ?? '').t('dialog.chooseFolder'),
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.openDirectory, (_event, dir: string, recursive?: boolean) =>
    deps.library.open(dir, { recursive })
  )

  /**
   * Open whatever was dropped on the window or handed over by "Open with".
   *
   * Dropping a folder opens it. Dropping a photo — or opening the app from
   * Explorer's context menu with a file selected — opens the folder that photo
   * lives in *and* reports which photo to focus, so the wall lands on the photo
   * the user pointed at rather than on the newest one in the folder.
   *
   * The path is resolved and type-checked in the main process: the renderer must
   * not be trusted to decide what a path is.
   */
  ipcMain.handle(
    IPC.openDropped,
    async (_event, target: string, recursive?: boolean): Promise<OpenDroppedResult> => {
      // Claim before resolving: `resolveOpenTarget` does a `stat`, which can be
      // slow on a sleeping drive. Claiming afterwards would order the opens by
      // when their `stat` finished rather than by when the user dropped them,
      // so dropping A then B could leave A on screen.
      const { generation, signal } = deps.library.claim()
      const resolved = await resolveOpenTarget(target)
      const result = await deps.library.open(resolved.dir, { recursive, generation, signal })
      return { ...result, photo: resolved.photo }
    }
  )

  ipcMain.handle(IPC.settingsLoad, () => loadSettings(deps.dataDir))
  ipcMain.handle(IPC.settingsSave, (_event, settings: Settings) => saveSettings(deps.dataDir, settings))
  ipcMain.handle(IPC.thumbUrl, (_event, photo: Photo, level: ThumbLevel, maxEdge?: number) =>
    deps.library.thumbUrlFor(photo, level, 'interactive', maxEdge)
  )

  // Resolve a batch of renditions, streaming each result back as it finishes.
  //
  // Waiting for the whole batch meant the first visible tiles were blocked
  // behind every other tile in the request. Pushing each one immediately lets
  // the wall fill in progressively. The level travels with the result so a slow
  // low-quality encode cannot overwrite a sharper one that already arrived.
  //
  // `priority` separates speculative work (scroll prefetching) from tiles that
  // are on screen right now. Without it a prefetch sits at the head of the
  // encode queue and the visible tiles wait behind photos the user is not even
  // looking at yet.
  ipcMain.handle(
    IPC.thumbUrls,
    async (event, photos: Photo[], level: ThumbLevel, priority: ThumbPriority = 'interactive'): Promise<void> => {
      const sender = event.sender
      await Promise.all(
        photos.map(async (photo) => {
          try {
            const url = await deps.library.thumbUrlFor(photo, level, priority)
            if (!sender.isDestroyed()) sender.send(IPC.thumbReady, [photo.id, url, level] as [string, string, ThumbLevel])
          } catch {
            // A single unreadable photo must not fail the whole batch; the tile
            // simply stays on its placeholder.
          }
        })
      )
    }
  )
  ipcMain.handle(IPC.revealInFolder, (_event, path: string) => shell.showItemInFolder(path))

  // Window controls for the custom title bar. Each one resolves the sender's
  // window rather than trusting a window id from the renderer.
  const windowOf = (event: { sender: Electron.WebContents }): Electron.BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle(IPC.windowMinimize, (event) => {
    windowOf(event)?.minimize()
  })

  ipcMain.handle(IPC.windowToggleMaximize, (event): boolean => {
    const window = windowOf(event)
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  ipcMain.handle(IPC.windowClose, (event) => {
    windowOf(event)?.close()
  })

  ipcMain.handle(IPC.windowState, (event): boolean => windowOf(event)?.isMaximized() ?? false)

  /**
   * Enter or leave OS fullscreen.
   *
   * Returns the resulting state rather than nothing: the renderer restores the
   * previous mode on exit, and a failed or ignored request has to be visible to
   * it, or the window would stay fullscreen after the show closes.
   */
  ipcMain.handle(IPC.windowFullScreen, (event, on: boolean): boolean => {
    const window = windowOf(event)
    if (!window) return false
    window.setFullScreen(on === true)
    return window.isFullScreen()
  })

  ipcMain.handle(IPC.windowIsFullScreen, (event): boolean => windowOf(event)?.isFullScreen() ?? false)

  /**
   * Full EXIF for one photo.
   *
   * The renderer supplies a path, so the request is untrusted: only photos the
   * library already knows about are readable. That reuses the same boundary as
   * `pic://` rather than inventing a second one, and stops a compromised
   * renderer from reading arbitrary files on disk.
   *
   * The first open of a photo parses the file and writes the result back, so
   * every later open — including after a restart — is a cache hit. That keeps
   * the scan from paying for fields nobody has looked at while still making the
   * common case (re-opening a photo you already inspected) instant.
   */
  ipcMain.handle(IPC.photoExif, async (_event, path: unknown): Promise<RawExif> => {
    if (typeof path !== 'string') return {}
    const photo = findPhoto(deps.library.all, path)
    if (!photo) return {}

    const cached = deps.library.metadataCache?.lookupExif(photo.path, photo.mtimeMs, photo.sizeBytes)
    if (cached) return cached

    const exif = await readFullExif(photo.path)
    deps.library.metadataCache?.storeExif(photo.path, photo.mtimeMs, photo.sizeBytes, exif)
    return exif
  })
}
