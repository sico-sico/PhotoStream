import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppInfo, CacheStats, OpenDroppedResult, Photo, ScanResult, Settings, ThumbLevel, ThumbPriority } from '../shared/types'
import type { RawExif } from '../shared/exif'
import { IPC } from '../shared/ipc'

/**
 * The only surface the renderer can reach.
 *
 * Every method is a narrow, typed wrapper: no raw `ipcRenderer`, no `require`,
 * no filesystem paths leaking in or out beyond what the UI actually shows.
 */
export interface PhotoStreamApi {
  appInfo: () => Promise<AppInfo>
  pickDirectory: (locale?: string) => Promise<string | null>
  /**
   * Open a folder. `recursive` includes photos in subfolders.
   *
   * The renderer passes its stored preference on every open rather than the main
   * process remembering one, so switching the setting and re-opening the same
   * folder takes effect immediately.
   */
  openDirectory: (dir: string, recursive?: boolean) => Promise<ScanResult>
  /**
   * Open a path dropped on the window.
   *
   * A file is accepted as well as a folder: dropping one photo opens the folder
   * it lives in and focuses it. `photo` is that file's path, or `''`.
   */
  openDropped: (path: string, recursive?: boolean) => Promise<OpenDroppedResult>
  /**
   * A photo handed to the app from outside — Explorer's "Open with", or a
   * second instance started that way.
   */
  onOpenExternal: (listener: (path: string) => void) => () => void
  /**
   * Absolute path behind a dropped `File`.
   *
   * `File.path` was removed in Electron 32, so the path has to be recovered in
   * the preload through `webUtils`. The renderer only ever sees the string.
   */
  pathForFile: (file: File) => string
  loadSettings: () => Promise<Settings>
  saveSettings: (settings: Settings) => Promise<Settings>
  /**
   * Disk usage of the thumbnail cache.
   *
   * `ready` is false until the startup sweep has walked the directory, so the
   * settings menu shows "calculating" instead of a misleading zero.
   */
  cacheStats: () => Promise<CacheStats>
  /**
   * URL of one rendition.
   *
   * `maxEdge` asks for a display-sized rendition instead of the level's fixed
   * size, so the viewer can receive a bitmap that matches the pixels it paints.
   */
  thumbUrl: (photo: Photo, level: ThumbLevel, maxEdge?: number) => Promise<string>
  /**
   * Start resolving many renditions. Results arrive incrementally through
   * `onThumbReady`, so the first tiles appear without waiting for the batch.
   *
   * `priority: 'background'` marks speculative work (scroll prefetching) so the
   * main process can encode tiles that are on screen first.
   */
  requestThumbs: (photos: Photo[], level: ThumbLevel, priority?: ThumbPriority) => Promise<void>
  /** One rendition that just finished: `[photoId, url, level]`. */
  onThumbReady: (listener: (entry: [string, string, ThumbLevel]) => void) => () => void
  revealInFolder: (path: string) => Promise<void>
  /** Full EXIF for one photo, read on demand for the viewer's info panel. */
  photoExif: (path: string) => Promise<RawExif>
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<boolean>
  close: () => Promise<void>
  /** True while the window is maximised, for the toggle button's icon. */
  isMaximized: () => Promise<boolean>
  /**
   * Enter or leave OS fullscreen, returning the state afterwards.
   *
   * Used by the random show, which is a viewing mode rather than a window
   * layout: it wants the screen, and it gives it back on exit.
   */
  setFullScreen: (on: boolean) => Promise<boolean>
  /** Whether the window is currently in OS fullscreen. */
  isFullScreen: () => Promise<boolean>
  onWindowState: (listener: (maximized: boolean) => void) => () => void
  onPhotosChanged: (listener: (payload: unknown) => void) => () => void
  onThumbProgress: (listener: (payload: { done: number; total: number }) => void) => () => void
}

const api: PhotoStreamApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  pickDirectory: (locale) => ipcRenderer.invoke(IPC.pickDirectory, locale),
  openDirectory: (dir, recursive) => ipcRenderer.invoke(IPC.openDirectory, dir, recursive),
  openDropped: (path, recursive) => ipcRenderer.invoke(IPC.openDropped, path, recursive),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      // A synthetic `File` (a paste or a test fixture) has no path; the caller
      // filters empty strings out, so this stays a no-op rather than a crash.
      return ''
    }
  },
  loadSettings: () => ipcRenderer.invoke(IPC.settingsLoad),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings),
  cacheStats: () => ipcRenderer.invoke(IPC.cacheStats),
  thumbUrl: (photo, level, maxEdge) => ipcRenderer.invoke(IPC.thumbUrl, photo, level, maxEdge),
  requestThumbs: (photos, level, priority) => ipcRenderer.invoke(IPC.thumbUrls, photos, level, priority),
  onThumbReady: (listener) => {
    const handler = (_event: unknown, entry: [string, string, ThumbLevel]): void => listener(entry)
    ipcRenderer.on(IPC.thumbReady, handler)
    return () => ipcRenderer.off(IPC.thumbReady, handler)
  },
  revealInFolder: (path) => ipcRenderer.invoke(IPC.revealInFolder, path),
  photoExif: (path) => ipcRenderer.invoke(IPC.photoExif, path),
  minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
  toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
  close: () => ipcRenderer.invoke(IPC.windowClose),
  isMaximized: () => ipcRenderer.invoke(IPC.windowState),
  setFullScreen: (on) => ipcRenderer.invoke(IPC.windowFullScreen, on),
  isFullScreen: () => ipcRenderer.invoke(IPC.windowIsFullScreen),
  onWindowState: (listener) => {
    const handler = (_event: unknown, maximized: boolean): void => listener(maximized)
    ipcRenderer.on(IPC.windowState, handler)
    return () => ipcRenderer.off(IPC.windowState, handler)
  },
  onPhotosChanged: (listener) => {
    const handler = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(IPC.photosChanged, handler)
    return () => ipcRenderer.off(IPC.photosChanged, handler)
  },
  onThumbProgress: (listener) => {
    const handler = (_event: unknown, payload: { done: number; total: number }): void => listener(payload)
    ipcRenderer.on(IPC.thumbProgress, handler)
    return () => ipcRenderer.off(IPC.thumbProgress, handler)
  },
  onOpenExternal: (listener) => {
    const handler = (_event: unknown, payload: { path?: unknown }): void => {
      // The payload crosses an IPC boundary, so treat it as untrusted.
      if (payload && typeof payload.path === 'string') listener(payload.path)
    }
    ipcRenderer.on(IPC.openExternal, handler)
    return () => ipcRenderer.off(IPC.openExternal, handler)
  }
}

contextBridge.exposeInMainWorld('photoStream', api)
