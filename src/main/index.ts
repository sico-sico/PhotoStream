import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { PhotoLibrary, registerIpc } from './ipc'
import { handlePicProtocol, registerPicScheme } from './protocol'
import { currentDataDir, resolveThumbCacheDir } from './paths'
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

  let photoDir = ''
  library = new PhotoLibrary(thumbCacheDir, broadcast)

  // Only the open library and the thumbnail cache may be served over pic://.
  handlePicProtocol(() => ({
    photoDir: library?.directory ?? '',
    thumbDir: thumbCacheDir
  }))

  registerIpc({
    library,
    dataDir,
    appVersion: app.getVersion(),
    // Electron resolves the OS preference list for us, including any
    // per-app overrides configured at the OS level.
    systemLocales: app.getPreferredSystemLanguages()
  })

  await createWindow(dataDir, thumbCacheDir)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(dataDir, thumbCacheDir)
  })

  void photoDir
})

app.on('window-all-closed', () => {
  library?.close()
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (error) => {
  // Surface rather than die silently: a crashed main process looks like a freeze.
  console.error('[main] uncaught exception', error)
})

export { IPC }
