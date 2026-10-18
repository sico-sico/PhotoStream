import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AppInfo, Photo, Settings, ThumbLevel } from '../shared/types'
import { IPC } from '../shared/ipc'
import { scanDirectory } from './scanner'
import { ensureThumbnail, ensureThumbnails, type ThumbRequest } from './thumbnails'
import { loadSettings, saveSettings } from './settings-store'
import { watchDirectory, type DirectoryWatcher, type RawWatchEvent } from './watcher'
import { thumbUrl, photoUrl } from './protocol'
import { findPhoto, removePhoto, sortPhotos, upsertPhoto } from '../shared/photoStore'
import { readImageMetadata } from './metadata'
import type { MetadataCache } from './metadata-cache'
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
    private readonly metadataCache?: MetadataCache
  ) {}

  get directory(): string {
    return this.dir
  }

  get all(): readonly Photo[] {
    return this.photos
  }

  /** Open a directory: scan it, start watching, and warm thumbnails in the background. */
  async open(dir: string): Promise<{ dir: string; photos: Photo[]; skipped: number; durationMs: number }> {
    this.close()
    const result = await scanDirectory(dir, { cache: this.metadataCache })
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
      const photo: Photo = {
        id: path.toLowerCase(),
        path,
        name: basename(path),
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
        void this.resolveEvents(events).then(({ touched, removed }) => {
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
  async thumbUrlFor(photo: Photo, level: ThumbLevel): Promise<string> {
    if (level === 'full') return photoUrl(basename(photo.path))
    const file = await ensureThumbnail(this.thumbCacheDir, toThumbRequest(photo, level))
    return thumbUrl(basename(file))
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

export interface IpcDeps {
  library: PhotoLibrary
  dataDir: string
  appVersion: string
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
      systemLocales: deps.systemLocales
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

  ipcMain.handle(IPC.openDirectory, (_event, dir: string) => deps.library.open(dir))
  ipcMain.handle(IPC.settingsLoad, () => loadSettings(deps.dataDir))
  ipcMain.handle(IPC.settingsSave, (_event, settings: Settings) => saveSettings(deps.dataDir, settings))
  ipcMain.handle(IPC.thumbUrl, (_event, photo: Photo, level: ThumbLevel) => deps.library.thumbUrlFor(photo, level))

  // Resolve a batch of renditions, streaming each result back as it finishes.
  //
  // Waiting for the whole batch meant the first visible tiles were blocked
  // behind every other tile in the request. Pushing each one immediately lets
  // the wall fill in progressively. The level travels with the result so a slow
  // low-quality encode cannot overwrite a sharper one that already arrived.
  ipcMain.handle(IPC.thumbUrls, async (event, photos: Photo[], level: ThumbLevel): Promise<void> => {
    const sender = event.sender
    await Promise.all(
      photos.map(async (photo) => {
        try {
          const url = await deps.library.thumbUrlFor(photo, level)
          if (!sender.isDestroyed()) sender.send(IPC.thumbReady, [photo.id, url, level] as [string, string, ThumbLevel])
        } catch {
          // A single unreadable photo must not fail the whole batch; the tile
          // simply stays on its placeholder.
        }
      })
    )
  })
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
}
