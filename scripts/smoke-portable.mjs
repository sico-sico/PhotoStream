#!/usr/bin/env node
/**
 * Smoke-test the packaged portable build.
 *
 * Launching the real exe is the only way to catch packaging faults that do not
 * appear in development: asar path resolution, unpacked native binaries
 * (sharp/libvips), the custom protocol, and the data folder next to the exe.
 *
 * Usage: node scripts/smoke-portable.mjs <portable-dir> [photo-dir]
 */
import { _electron as electron } from 'playwright'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const appDir = process.argv[2]
const photoDir = process.argv[3]

if (!appDir) {
  console.error('Usage: node scripts/smoke-portable.mjs <portable-dir> [photo-dir]')
  process.exit(1)
}

const exe = join(appDir, 'PhotoStream.exe')
if (!existsSync(exe)) {
  console.error(`Missing executable: ${exe}`)
  process.exit(1)
}

const app = await electron.launch({ executablePath: exe })
const page = await app.firstWindow()

const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`)
})

await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)

console.log('title:      ', await page.title())
console.log('lang:       ', await page.locator('html').getAttribute('lang'))
console.log('buttons:    ', await page.locator('button').count())

const dataDir = join(appDir, 'PhotoStreamData')
console.log('data dir:   ', existsSync(dataDir) ? 'created next to exe' : 'MISSING')

const info = await page.evaluate(() => window.photoStream.appInfo())
console.log('appInfo.dataDir:', info.dataDir)
console.log('app version:    ', info.version)

if (photoDir) {
  // Stub the native dialog: no OS picker can be clicked from here.
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, photoDir)

  // Open through the app UI so the whole real path runs: IPC -> scanner ->
  // sharp (unpacked from asar) -> pic:// protocol -> <img>.
  await page.locator('.empty-state button.primary').click()
  await page.waitForSelector('[data-photo-id]', { timeout: 20_000 })

  const tiles = await page.locator('[data-photo-id]').count()
  const caption = await page.locator('.tile-caption').first().textContent()
  console.log('tiles:      ', tiles)
  console.log('caption:    ', caption)

  const naturalWidth = await page
    .locator('[data-photo-id] img')
    .first()
    .evaluate((img) => img.naturalWidth)
  console.log('thumb width:', naturalWidth)

  if (naturalWidth === 0) errors.push('thumbnail failed to render through pic://')
  if (tiles === 0) errors.push('no tiles rendered')
}

console.log('errors:     ', errors.length === 0 ? 'none' : errors.join(' | '))

await app.close()
process.exit(errors.length === 0 ? 0 : 1)
