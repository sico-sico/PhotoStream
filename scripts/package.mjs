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
import { rm, rename, mkdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')
const appName = 'PhotoStream'

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
