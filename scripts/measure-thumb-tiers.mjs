// Measure the on-disk size of each thumbnail tier, on a real library.
//
// The two cached tiers are 512px and 2560px WebP, but the number that matters is
// bytes on disk: a library is browsed by scrolling, which produces `wall` files
// for everything it passes, while `zoom` files only appear where the user
// actually magnified. This reports both, and what a fully covered library would
// cost.
//
// Usage: node scripts/measure-thumb-tiers.mjs <photoDir>
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const photoDir = process.argv[2]
if (!photoDir) {
  console.error('usage: node scripts/measure-thumb-tiers.mjs <photoDir>')
  process.exit(1)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'photostream-tiers-'))
const dataDir = join(userDataDir, 'PhotoStreamData')
await mkdir(dataDir, { recursive: true })
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify(
    { lastDir: photoDir, layout: 'grid', sort: 'taken-desc', filters: { from: '', to: '', text: '' }, locale: 'en', history: [], recursive: false },
    null,
    2
  ),
  'utf-8'
)

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForSelector('[data-photo-id]', { timeout: 120_000 })
await page.waitForTimeout(5000)

const stage = await page.getByTestId('stage').boundingBox()
await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)

// Zoom far enough in that `pickThumbLevel` crosses into the zoom tier: it needs
// worldPixels * scale * dpr > 512 * 0.9, and tiles are 240 world px.
for (let i = 0; i < 12; i += 1) {
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await page.waitForTimeout(120)
}
await page.waitForTimeout(3000)

async function tierStats(dir, suffix) {
  const sizes = []
  async function walk(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith(suffix)) {
        try {
          sizes.push((await stat(full)).size)
        } catch {
          /* raced */
        }
      }
    }
  }
  await walk(dir)
  if (sizes.length === 0) return { count: 0 }
  const sum = sizes.reduce((a, b) => a + b, 0)
  sizes.sort((a, b) => a - b)
  return {
    count: sizes.length,
    avgKB: Math.round((sum / sizes.length / 1024) * 10) / 10,
    medianKB: Math.round((sizes[Math.floor(sizes.length / 2)] / 1024) * 10) / 10,
    minKB: Math.round((sizes[0] / 1024) * 10) / 10,
    maxKB: Math.round((sizes[sizes.length - 1] / 1024) * 10) / 10,
    totalMB: Math.round((sum / (1024 * 1024)) * 10) / 10
  }
}

const thumbs = join(dataDir, 'thumbs')
const report = {
  wall: await tierStats(thumbs, '-wall.webp'),
  zoom: await tierStats(thumbs, '-zoom.webp')
}

// Project a fully browsed library: every photo scrolled past once (wall), and
// every photo magnified once (zoom).
const total = (await page.evaluate(() => document.querySelectorAll('[data-photo-id]').length)) || 0
const librarySize = Number(process.env.LIBRARY_COUNT ?? 0)
if (librarySize > 0 && report.wall.count > 0) {
  const perWall = report.wall.avgKB / 1024
  const perZoom = report.zoom.avgKB ? report.zoom.avgKB / 1024 : 0
  report.projection = {
    photos: librarySize,
    wallOnlyMB: Math.round(perWall * librarySize),
    bothTiersMB: Math.round((perWall + perZoom) * librarySize)
  }
} else {
  report.visibleTiles = total
}

console.log(JSON.stringify(report, null, 2))
await app.close()
