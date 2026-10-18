import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { PhotoLibrary, registerIpc } from './ipc'
import { handlePicProtocol, registerPicScheme } from './protocol'
import { currentDataDir, resolveThumbCacheDir } from './paths'
import { MetadataCache } from './metadata-cache'
import { photoFromArgv } from './drop'
import { mkdir } from 'node:fs/promises'

// Must run before `app.ready`: privileged schemes cannot be registered later.
registerPicScheme()

const isDev = !app.isPackaged

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
  library = new PhotoLibrary(thumbCacheDir, broadcast, metadataCache)

  // Only the open library and the thumbnail cache may be served over pic://.
  handlePicProtocol(() => ({
    photoDir: library?.directory ?? '',
    thumbDir: thumbCacheDir
  }))

  registerIpc({
    library,
    dataDir,
    appVersion: app.getVersion(),
    // Reported so the About dialog can name the exact runtime; a rendering or
    // protocol bug is much easier to place when the Chromium build is known.
    versions: { electron: process.versions.electron, chromium: process.versions.chrome },
    // Electron resolves the OS preference list for us, including any
    // per-app overrides configured at the OS level.
    systemLocales: app.getPreferredSystemLanguages()
  })

  await createWindow(dataDir, thumbCacheDir)

  // A photo handed over on the command line ("Open with → PhotoStream") has to
  // wait for the renderer to be ready, or the IPC message lands before anything
  // is listening. `createWindow` resolves once the page has loaded.
  const launchPhoto = photoFromArgv(process.argv)
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
