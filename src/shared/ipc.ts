/** IPC channel names shared by main, preload and renderer. */
export const IPC = {
  appInfo: 'app:info',
  pickDirectory: 'dialog:pickDirectory',
  openDirectory: 'photos:open',
  photosChanged: 'photos:changed',
  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',
  thumbUrl: 'thumb:url',
  thumbProgress: 'thumb:progress',
  revealInFolder: 'shell:reveal'
} as const

/** Custom protocol used to stream cached thumbnails and originals to the renderer. */
export const PIC_SCHEME = 'pic'
export const PIC_THUMB_HOST = 'thumb'
export const PIC_PHOTO_HOST = 'photo'
