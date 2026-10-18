#!/usr/bin/env node
/**
 * Build the portable Windows bundle.
 *
 * `@electron/packager` is used instead of `electron-builder`: the latter pulls
 * a chain of deprecated and vulnerable transitive packages (rimraf@2, glob@7,
 * inflight, boolean, sprintf-js) into a project that otherwise has none. The
 * packager produces the same directory-shaped output, which is exactly what a
 * portable build needs — the user unzips it and runs the exe.
 */
import { packager } from '@electron/packager'
import { rm, rename, mkdir, cp, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')
const appName = 'PhotoStream'

/**
 * Chromium locale packs to keep.
 *
 * Electron ships one `.pak` per UI language — 55 of them, 1.4–1.7 MB each and
 * 48 MB in total — but the app translates its own strings through
 * `shared/i18n`. The Chromium bundles are only consulted for built-in pieces
 * (context menus, file dialogs, form validation bubbles), so keeping every
 * language would mean shipping ~45 MB of text nobody can reach.
 *
 * The list covers the three shipped languages plus the two variants Windows
 * commonly reports (`en-GB`, `zh-TW`); anything else falls back to `en-US`.
 */
const KEPT_LOCALES = ['en-US.pak', 'en-GB.pak', 'zh-CN.pak', 'zh-TW.pak', 'fr.pak']

/**
 * Remove files from the packaged bundle that the app cannot use.
 *
 * Runs after the packager finishes, because these files come from the Electron
 * distribution rather than from this repository — `ignore` only filters our own
 * sources.
 */
async function pruneBundle(portable) {
  const removed = []

  const localesDir = join(portable, 'locales')
  if (existsSync(localesDir)) {
    for (const name of await readdir(localesDir)) {
      if (KEPT_LOCALES.includes(name)) continue
      await rm(join(localesDir, name), { recursive: true, force: true })
      removed.push(`locales/${name}`)
    }
  }

  // `LICENSES.chromium.html` is a 19.5 MB legal notice. Shipping it is the
  // correct thing for a distributed product, so it is deliberately kept; it is
  // listed here only to document the decision.
  return removed
}

async function main() {
  // Start from a clean slate so a stale bundle cannot be mistaken for a new one.
  await rm(releaseDir, { recursive: true, force: true })
  await mkdir(releaseDir, { recursive: true })

  const [outputPath] = await packager({
    dir: root,
    out: releaseDir,
    name: appName,
    platform: 'win32',
    arch: 'x64',
    executableName: appName,
    appVersion: JSON.parse(await readText(join(root, 'package.json'))).version,
    // An .ico with 16/24/32/48/64/128/256 entries: Windows picks the right one
    // for the taskbar, explorer and the high-DPI variants from a single file.
    icon: join(root, 'build', 'icon.ico'),
    // Everything the app needs is already built into `out/`.
    ignore: [
      /^\/src($|\/)/,
      /^\/tests($|\/)/,
      /^\/scripts($|\/)/,
      /^\/release($|\/)/,
      /^\/out\/renderer\/assets\/.*\.map$/,
      /^\/\.git($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/test-results($|\/)/,
      /^\/playwright-report($|\/)/,
      /^\/coverage($|\/)/,
      /^\/docs($|\/)/,
      /^\/[^/]*\.(md|log)$/,
      /^\/(vitest|playwright|electron\.vite)\.config\.ts$/,
      /^\/tsconfig.*\.json$/,
      /^\/(e2e-run|debug-out)\.txt$/
    ],
    // libvips ships native binaries that cannot be read from an asar archive.
    asar: { unpack: '**/node_modules/{sharp,@img}/**/*' }
  })

  // Packager appends a platform/arch suffix; give the folder a name a user can
  // actually recognise when it lands on the desktop.
  const bundled = join(releaseDir, `${appName}-win32-x64`)
  const portable = join(releaseDir, `${appName}-portable-win-x64`)
  if (existsSync(bundled)) await rename(bundled, portable)

  const removed = await pruneBundle(portable)
  if (removed.length > 0) console.log(`Pruned ${removed.length} unused Chromium locale pack(s).`)

  // Ship the notes next to the exe: the portable build has no installer to
  // explain where the data lives.
  const readme = join(portable, 'README.txt')
  await writeFileSafe(
    readme,
    [
      `${appName} portable`,
      '',
      'Run PhotoStream.exe. No installation is required.',
      '',
      `All data is written to the "${appName}Data" folder next to the exe:`,
      '  settings.json  - layout, filters, last folder, language',
      '  thumbs/        - cached thumbnails (safe to delete)',
      '',
      'To move the app, copy or move the whole folder and keep the "Data"',
      'folder with it. Deleting it resets the app to a fresh state.'
    ].join('\n')
  )

  console.log(`\nPortable build written to:\n  ${portable}`)
}

async function readText(path) {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf-8')
}

async function writeFileSafe(path, text) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, text, 'utf-8')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
