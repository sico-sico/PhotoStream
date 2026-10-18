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

  /** Open a directory: scan it, start watching, and warm thumbnails in the background. */
  async open(dir: string, options: { recursive?: boolean } = {}): Promise<ScanResult> {
    this.close()
    this.recursive = options.recursive === true
    const result = await scanDirectory(dir, { cache: this.metadataCache, recursive: this.recursive })
    this.photos = result.photos
    this.dir = result.dir
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
    return watchDirectory(dir, {
      onEvents: (events) => {
        // The watcher is always recursive, so it sees subfolders whether or not
        // they are part of the library. Filtering here keeps the scan and the
        // watcher consistent: with the setting off, a new file in a subfolder
        // must not appear on the wall.
        const relevant = this.recursive
          ? events
          : events.filter((event) => !relativePath(dir, event.path).includes(sep))

        if (relevant.length === 0) return
        void this.resolveEvents(relevant).then(({ touched, removed }) => {
          // A deletion changes the wall without producing a photo to thumbnail.
          if (touched.length === 0 && !removed) return
          // New photos need thumbnails; changed ones need theirs rebuilt.
          if (touched.length > 0) this.warmThumbnails(touched, 'wall')
          this.notify(IPC.photosChanged, { kind: 'delta', photos: this.photos })
        })
      },
      onError: (error) => this.notify(IPC.photosChanged, { kind: 'error', message: error.message })
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
   */
  async thumbUrlFor(photo: Photo, level: ThumbLevel, priority: ThumbPriority = 'interactive'): Promise<string> {
    if (level === 'full') return photoUrl(relativeTo(this.dir, photo.path))
    const file = await ensureThumbnail(this.thumbCacheDir, toThumbRequest(photo, level), priority)
    // Relative, not `basename`: the cache is sharded into `a/b/` subdirectories,
    // and the `pic://thumb` handler resolves the path against the cache root.
    return thumbUrl(relativeTo(this.thumbCacheDir, file))
  }
}

function toThumbRequest(photo: Photo, level: Exclude<ThumbLevel, 'full'>): ThumbRequest {
  return {
    sourcePath: photo.path,
    mtimeMs: photo.mtimeMs,
    sizeBytes: photo.sizeBytes,
    level
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
      const resolved = await resolveOpenTarget(target)
      const result = await deps.library.open(resolved.dir, { recursive })
      return { ...result, photo: resolved.photo }
    }
  )

  ipcMain.handle(IPC.settingsLoad, () => loadSettings(deps.dataDir))
  ipcMain.handle(IPC.settingsSave, (_event, settings: Settings) => saveSettings(deps.dataDir, settings))
  ipcMain.handle(IPC.thumbUrl, (_event, photo: Photo, level: ThumbLevel) => deps.library.thumbUrlFor(photo, level))

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
