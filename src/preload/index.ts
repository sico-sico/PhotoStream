import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, Photo, Settings, ThumbLevel } from '../shared/types'
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
  openDirectory: (dir: string) => Promise<{ dir: string; photos: Photo[]; skipped: number; durationMs: number }>
  loadSettings: () => Promise<Settings>
  saveSettings: (settings: Settings) => Promise<Settings>
  thumbUrl: (photo: Photo, level: ThumbLevel) => Promise<string>
  /**
   * Start resolving many renditions. Results arrive incrementally through
   * `onThumbReady`, so the first tiles appear without waiting for the batch.
   */
  requestThumbs: (photos: Photo[], level: ThumbLevel) => Promise<void>
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
  onWindowState: (listener: (maximized: boolean) => void) => () => void
  onPhotosChanged: (listener: (payload: unknown) => void) => () => void
  onThumbProgress: (listener: (payload: { done: number; total: number }) => void) => () => void
}

const api: PhotoStreamApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  pickDirectory: (locale) => ipcRenderer.invoke(IPC.pickDirectory, locale),
  openDirectory: (dir) => ipcRenderer.invoke(IPC.openDirectory, dir),
  loadSettings: () => ipcRenderer.invoke(IPC.settingsLoad),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings),
  thumbUrl: (photo, level) => ipcRenderer.invoke(IPC.thumbUrl, photo, level),
  requestThumbs: (photos, level) => ipcRenderer.invoke(IPC.thumbUrls, photos, level),
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
  }
}

contextBridge.exposeInMainWorld('photoStream', api)
