/**
 * Message catalogue: English is the single source of truth for message keys.
 *
 * `MessageKey` is derived from this object, so every other locale is checked at
 * compile time — adding a key here immediately makes all translations fail to
 * type-check until they are filled in. That is intentional: a missing
 * translation is a build error rather than a string that silently leaks into
 * the UI.
 *
 * Placeholders use `{name}` syntax and are substituted by `translate()`.
 */
export const en = {
  'app.title': 'PhotoStream',
  'app.emptyTitle': 'PhotoStream',
  'app.emptyBody': 'Choose a folder of JPEGs, or drop one onto this window, to build your wall.',
  'app.emptyAction': 'Open folder…',
  'app.dropHint': 'Drop a folder or a photo to open it',
  'app.errorRetry': 'Try another folder',

  'toolbar.openFolder': 'Open folder…',
  'toolbar.openFolderHint': 'Open a folder, or drop one anywhere on the window',
  'toolbar.scanning': 'Scanning…',
  'toolbar.noFolder': 'No folder selected',
  'toolbar.layoutAria': 'Layout',
  'toolbar.layoutGrid': 'Rows',
  'toolbar.layoutGridHint': 'Justified rows, original proportions',
  'toolbar.layoutMasonry': 'Masonry',
  'toolbar.layoutMasonryHint': 'Columns, original proportions',
  'toolbar.layoutSquare': 'Square',
  'toolbar.layoutSquareHint': 'Uniform square grid',
  'toolbar.filters': 'Filters',
  'toolbar.sort': 'Sort order',
  'toolbar.sortNewest': 'Newest first',
  'toolbar.sortOldest': 'Oldest first',
  'toolbar.sortNameAsc': 'Name A→Z',
  'toolbar.sortNameDesc': 'Name Z→A',
  'toolbar.photoCount': '{visible} of {total} photos',
  'toolbar.language': 'Language',
  'toolbar.settings': 'Settings',

  'settings.recursive': 'Include photos in subfolders',

  'history.show': 'Recent folders',
  'history.title': 'Recent folders',
  'history.remove': 'Forget {name}',
  'history.clear': 'Clear all',
  'history.empty': 'No recent folders yet',

  'filters.aria': 'Filters',
  'filters.from': 'Date from',
  'filters.to': 'Date to',
  'filters.fileName': 'File name',
  'filters.fileNamePlaceholder': 'e.g. Kyoto or IMG_*',
  'filters.fileNameHint': 'Use * for any characters and ? for one; without a wildcard it matches anywhere in the name.',
  'filters.reset': 'Reset',
  'filters.range': '{min} → {max}',
  'filters.active': 'filtered',

  'wall.aria': 'Photo wall',
  'wall.scrollbar': 'Scroll the wall',

  'tile.noDate': 'no capture date',
  'tile.unknownDate': '—',

  'viewer.prev': 'Previous photo',
  'viewer.next': 'Next photo',
  'viewer.close': 'Close viewer',
  'viewer.reveal': 'Show in folder',
  'viewer.fit': 'Fit',
  'viewer.rotateLeft': 'Rotate left',
  'viewer.rotateRight': 'Rotate right',
  'viewer.noDate': 'no capture date',
  'viewer.size': '{width}×{height}',
  'viewer.info': 'Details',
  'viewer.hideInfo': 'Hide details',
  'exif.loading': 'Reading details…',

  'show.enter': 'Random show',
  'show.enterHint': 'Browse the current folder at random; click a photo to bring it to the centre',
  'show.exit': 'Leave the random show',
  'show.exitHint': 'Leave the random show (Esc)',
  'show.aria': 'Random photo show',
  'show.paused': 'Paused — move the pointer off a photo to continue',
  'show.empty': 'No photos to show',
  'show.emptyHint': 'Open a folder with photos, or widen the current filters.',
  'show.counter': '{shown} of {total}',

  'exif.camera': 'Camera',
  'exif.exposure': 'Exposure',
  'exif.location': 'Location',
  'exif.file': 'File',
  'exif.make': 'Camera',
  'exif.lens': 'Lens',
  'exif.focalLength': 'Focal length',
  'exif.aperture': 'Aperture',
  'exif.shutter': 'Shutter',
  'exif.iso': 'ISO',
  'exif.exposureBias': 'Exposure bias',
  'exif.flash': 'Flash',
  'exif.flashFired': 'Fired',
  'exif.flashOff': 'Did not fire',
  'exif.metering': 'Metering',
  'exif.whiteBalance': 'White balance',
  'exif.capturedAt': 'Captured',
  'exif.coordinates': 'Coordinates',
  'exif.altitude': 'Altitude',
  'exif.fileName': 'File name',
  'exif.dimensions': 'Dimensions',
  'exif.software': 'Software',

  'dialog.chooseFolder': 'Choose photo folder',

  'about.title': 'About PhotoStream',
  'about.version': 'Version {version}',
  'about.description': 'A photo wall for a folder of JPEGs. Scan, pan, zoom, inspect.',
  'about.runtime': 'Runtime',
  'about.electron': 'Electron {version}',
  'about.chromium': 'Chromium {version}',
  'about.source': 'Source code',
  'about.reportIssue': 'Report an issue',
  'about.author': 'Written by',
  'about.authorValue': 'GitHub Copilot (DeepSeek V4 Flash)',
  'about.dataLocation': 'Data folder',
  'about.shortcuts': 'Keyboard shortcuts',
  'about.shortcutPan': 'Arrow keys — pan the wall',
  'about.shortcutPanLarge': 'Shift + arrows — pan faster',
  'about.shortcutFocus': 'Alt + arrows — move between photos',
  'about.shortcutViewer': 'Enter / Space — open the selected photo',
  'about.shortcutClose': 'Esc — close the viewer or dialog',
  'about.shortcutInfo': 'I — details inside the viewer',
  'about.close': 'Close',

  'window.minimize': 'Minimize',
  'window.maximize': 'Maximize',
  'window.restore': 'Restore',
  'window.close': 'Close'
} as const

/** Every message the UI can ask for. */
export type MessageKey = keyof typeof en

/**
 * A complete translation. Missing keys are a type error, which is what keeps a
 * new UI string from shipping untranslated.
 */
export type Catalog = { readonly [K in MessageKey]: string }

/** Values substituted into `{placeholder}` markers. */
export type MessageParams = Readonly<Record<string, string | number>>
