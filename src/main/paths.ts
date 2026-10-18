import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Portable data layout.
 *
 * Everything the app writes lives next to the executable in `PhotoStreamData/`
 * so the whole thing can be copied to a USB stick or deleted cleanly. In
 * development the project root is used instead, which keeps `npm run dev`
 * from scattering files into the repo.
 */
export const DATA_DIR_NAME = 'PhotoStreamData'

/** True when running from a packaged build (an app.asar / exe directory). */
export function isPackaged(): boolean {
  return app.isPackaged
}

/**
 * Directory that should hold `PhotoStreamData`.
 * Falls back to `userData` when the executable directory is read-only (for
 * example when the app is run from a mounted image).
 */
export function baseDirectory(options: { packaged: boolean; exePath: string; userData: string }): string {
  if (!options.packaged) return options.userData
  const dir = dirname(options.exePath)
  return existsSync(dir) ? dir : options.userData
}

/**
 * Explicit data-directory override, used to isolate test runs.
 *
 * Deliberately read from the environment rather than a command-line flag: it
 * has to be in place before `app.ready`, and it must not be settable by a
 * document the renderer loads.
 */
export function dataDirOverride(): string {
  const override = process.env['PHOTOSTREAM_USER_DATA']
  return typeof override === 'string' ? override.trim() : ''
}

export function resolveDataDir(options: { packaged: boolean; exePath: string; userData: string }): string {
  return join(baseDirectory(options), DATA_DIR_NAME)
}

export function resolveThumbCacheDir(dataDir: string): string {
  return join(dataDir, 'thumbs')
}

/** Data directory for the current process. */
export function currentDataDir(): string {
  const override = dataDirOverride()
  if (override) return join(override, DATA_DIR_NAME)

  return resolveDataDir({
    packaged: app.isPackaged,
    exePath: app.getPath('exe'),
    userData: app.getPath('userData')
  })
}
