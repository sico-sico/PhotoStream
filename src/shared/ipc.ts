/** IPC channel names shared by main, preload and renderer. */
export const IPC = {
  appInfo: 'app:info',
  pickDirectory: 'dialog:pickDirectory',
  openDirectory: 'photos:open',
  openDropped: 'photos:openDropped',
  openExternal: 'photos:openExternal',
  photosChanged: 'photos:changed',
  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',
  cacheStats: 'cache:stats',
  scanSeed: 'photos:scanSeed',
  thumbUrl: 'thumb:url',
  thumbUrls: 'thumb:urls',
  thumbReady: 'thumb:ready',
  thumbProgress: 'thumb:progress',
  photoExif: 'photo:exif',
  revealInFolder: 'shell:reveal',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowState: 'window:state',
  windowFullScreen: 'window:fullScreen',
  windowIsFullScreen: 'window:isFullScreen'
} as const

/** Custom protocol used to stream cached thumbnails and originals to the renderer. */
export const PIC_SCHEME = 'pic'
export const PIC_THUMB_HOST = 'thumb'
export const PIC_PHOTO_HOST = 'photo'
