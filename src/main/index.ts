import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { PhotoLibrary, registerIpc } from './ipc'
import { handlePicProtocol, registerPicScheme } from './protocol'
import { currentDataDir, resolveThumbCacheDir } from './paths'
import { MetadataCache } from './metadata-cache'
import { photoFromArgv } from './drop'
import { ThumbCache } from './cache-maintenance'
import { loadSettings } from './settings-store'
import { mkdir } from 'node:fs/promises'

// Must run before `app.ready`: privileged schemes cannot be registered later.
registerPicScheme()

const isDev = !app.isPackaged

/**
 * How long to wait before the first cache sweep.
 *
 * The first second of a session belongs to the scan and to the tiles on screen;
 * a directory walk competing for the disk there makes the wall visibly slower.
 * Ten seconds is long after the first screenful has encoded and short enough to
 * still feel like part of startup.
 */
const CACHE_SWEEP_DELAY_MS = 10_000

let mainWindow: BrowserWindow | null = null
let library: PhotoLibrary | null = null

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

async function createWindow(dataDir: string, thumbCacheDir: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#101014',
    title: 'PhotoStream',
    /**
     * A frameless window still shows an icon in the taskbar and Alt-Tab list.
     *
     * A packaged build gets it from the `.ico` embedded in the exe, so passing a
     * path is only meaningful in development — and there the path has to point
     * outside `out/`, at the repository's `build/` folder.
     */
    ...(isDev ? { icon: join(__dirname, '../../build/icon.png') } : {}),
    // The default title bar only repeated the app name and the default menu was
    // a stock Electron template with no commands behind it. Both are removed;
    // the renderer draws its own controls and can drag the window via CSS.
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security baseline: the renderer never gets Node, and only the
      // allow-listed API in preload crosses the context bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // A frameless window on Windows has no system menu; removing it also stops
  // Alt from revealing an empty menu bar.
  Menu.setApplicationMenu(null)

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Never let the app navigate away from its own UI or open arbitrary windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost')) event.preventDefault()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  void dataDir
  void thumbCacheDir
}

app.whenReady().then(async () => {
  const dataDir = currentDataDir()
  const thumbCacheDir = resolveThumbCacheDir(dataDir)
  await mkdir(thumbCacheDir, { recursive: true })

  // One database for the whole session: EXIF parsing is the dominant cost of
  // opening a folder (measured at 1178 ms of 1296 ms for 3226 photos), and the
  // cache turns a repeat visit into a handful of indexed lookups.
  const metadataCache = new MetadataCache(join(dataDir, 'metadata.db'))

  /*
   * The settings are read here as well as in the renderer.
   *
   * The renderer owns every preference the UI shows, but the cache limit has to
   * be known before the first sweep, which happens without the renderer asking.
   * Reading the small JSON file once more at startup is cheaper than routing the
   * value back through IPC before maintenance can begin.
   */
  const settings = await loadSettings(dataDir)
  const thumbCache = new ThumbCache(thumbCacheDir, settings.cacheBudgetMb * 1024 * 1024)

  library = new PhotoLibrary(thumbCacheDir, broadcast, metadataCache, (bytes) =>
    thumbCache.noteWritten(bytes)
  )

  // Only the open library and the thumbnail cache may be served over pic://.
  handlePicProtocol(() => ({
    photoDir: library?.directory ?? '',
    thumbDir: thumbCacheDir
  }))

  registerIpc({
    library,
    dataDir,
    cache: thumbCache,
    appVersion: app.getVersion(),
    // Reported so the About dialog can name the exact runtime; a rendering or
    // protocol bug is much easier to place when the Chromium build is known.
    versions: { electron: process.versions.electron, chromium: process.versions.chrome },
    // Electron resolves the OS preference list for us, including any
    // per-app overrides configured at the OS level.
    systemLocales: app.getPreferredSystemLanguages()
  })

  // A photo handed over on the command line ("Open with → PhotoStream") has to
  // wait for the renderer to be ready, or the IPC message lands before anything
  // is listening. Reading the argument is cheap; the hand-off happens below.
  const launchPhoto = photoFromArgv(process.argv)

  // Window first (that call does not block on the page loading), then the scan
  // the renderer is about to ask for: it runs while the page is still loading
  // and React is mounting. `open()` adopts it, so the folder is read once.
  //
  // Skipped when a photo was handed over on the command line — that opens the
  // photo's own folder, for which this scan would be abandoned immediately.
  const windowReady = createWindow(dataDir, thumbCacheDir)
  if (settings.lastDir && !launchPhoto) {
    library.prefetch(settings.lastDir, { recursive: settings.recursive })
  }
  await windowReady

  /*
   * Housekeeping runs after the window is up, never before: it walks the whole
   * cache, which on a USB stick or a cold NTFS volume is seconds of I/O that
   * would otherwise compete with the scan and the first tiles.
   *
   * `force` because this is the pass that also computes the size the settings
   * menu reports; the throttle only exists to bound budget-triggered sweeps.
   */
  setTimeout(() => {
    void thumbCache.sweep({ force: true }).catch(() => undefined)
  }, CACHE_SWEEP_DELAY_MS)

  // The renderer is listening only now, which is why the hand-off waits for the
  // page: the IPC message would otherwise land before anything receives it.
  if (launchPhoto) void openExternalPhoto(launchPhoto)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(dataDir, thumbCacheDir)
  })
})

/**
 * Hand a photo to the renderer to open.
 *
 * The window is focused first: when this comes from a second instance the user
 * has just clicked the app in Explorer, so the window should come forward rather
 * than silently change behind whatever they were looking at.
 *
 * Routed through the same notification the watcher uses, so the renderer's
 * existing "open this path" handler is what runs — dropping a file and opening
 * it from Explorer therefore behave identically by construction.
 */
function openExternalPhoto(path: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  broadcast(IPC.openExternal, { path })
}

/**
 * "Open with → PhotoStream" starts a *new* process each time, so without this the
 * user would get a second window and a second thumbnail queue. The second
 * instance forwards its arguments to the first and exits.
 */
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const path = photoFromArgv(argv)
    if (path) openExternalPhoto(path)
    else if (mainWindow && !mainWindow.isDestroyed()) {
      // Launched with no file (a plain double-click on the exe while running):
      // just bring the existing window forward.
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.on('window-all-closed', () => {
  library?.close()
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (error) => {
  // Surface rather than die silently: a crashed main process looks like a freeze.
  console.error('[main] uncaught exception', error)
})

export { IPC }
