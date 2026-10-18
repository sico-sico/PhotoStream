import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, Photo, Settings, ThumbLevel } from '../shared/types'
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
  revealInFolder: (path: string) => Promise<void>
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
  revealInFolder: (path) => ipcRenderer.invoke(IPC.revealInFolder, path),
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
