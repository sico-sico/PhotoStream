// Measure whether a scrollbar jump lands on loaded tiles.
//
// The scrollbar exists to cross a year of photos in one gesture, so the tiles at
// the destination have to be requested *before* the jump finishes. This samples
// blank tiles every 50 ms and reports how long the landing takes to fill.
//
// Usage: node scripts/measure-scroll-prefetch.mjs <photoDir> [end|0.6] [dataDir]
//   dataDir: reuse a directory to keep the thumbnail cache warm between runs.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [photoDir, jump = 'end', reuseDir] = process.argv.slice(2)
if (!photoDir) {
  console.error('usage: node scripts/measure-scroll-prefetch.mjs <photoDir> [end|0.6] [dataDir]')
  process.exit(1)
}

const userDataDir = reuseDir ?? (await mkdtemp(join(tmpdir(), 'photostream-prefetch-')))
const dataDir = join(userDataDir, 'PhotoStreamData')
await mkdir(dataDir, { recursive: true })
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify(
    { lastDir: photoDir, layout: 'grid', sort: 'taken-desc', filters: { from: '', to: '', text: '' }, locale: 'en', history: [] },
    null,
    2
  ),
  'utf-8'
)

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir, PHOTOSTREAM_DEBUG_THUMBS: '1' }
})

/** Every `[thumbs]` line the main process prints, tagged with arrival order. */
const thumbLog = []
app.process().stdout?.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    if (line.includes('[thumbs]')) thumbLog.push(line.trim())
  }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForSelector('[data-photo-id]', { timeout: 120_000 })
// Let the opening burst settle so the measurement is about the jump alone.
await page.waitForTimeout(6000)

/** Loaded vs blank tiles currently mounted near the viewport. */
const sample = () =>
  page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('[data-photo-id]'))
    const loaded = tiles.filter((tile) => tile.querySelector('img')).length
    const blank = tiles.length - loaded
    const world = document.querySelector('[data-testid="world"]')
    const m = world && /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(world.style.transform)
    return { mounted: tiles.length, loaded, blank, worldY: m ? Math.round(Number(m[2])) : 0 }
  })

const bar = page.getByTestId('wall-scrollbar')
await bar.waitFor({ state: 'visible' })

const before = await sample()

if (jump === 'end') {
  await bar.focus()
  await page.keyboard.press('End')
} else if (jump === 'drag') {
  // Drag the thumb from the top to 60% of the track, as a user sweeping across
  // months would. This is the case where the viewport path is asked to load
  // every band the thumb passes over.
  const box = await bar.boundingBox()
  const thumb = await page.locator('.scrollbar-thumb').boundingBox()
  await page.mouse.move(box.x + box.width / 2, thumb.y + thumb.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6, { steps: 30 })
  await page.mouse.up()
} else {
  const box = await bar.boundingBox()
  const fraction = Number(jump)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * fraction)
  await page.mouse.down()
  await page.mouse.up()
}

// Poll every 50 ms until the landing is fully loaded or 5 s have passed; a fixed
// schedule misses the moment the wall becomes usable, which is the number that
// matters.
const started = Date.now()
const series = []
let filledAt = null
while (Date.now() - started < 5000) {
  const at = Date.now() - started
  const snap = await sample()
  series.push({ at, mounted: snap.mounted, loaded: snap.loaded, blank: snap.blank, worldY: snap.worldY })
  if (snap.mounted > 0 && snap.blank === 0) {
    filledAt = at
    break
  }
  await page.waitForTimeout(50)
}

console.log(JSON.stringify({ jump, before, filledAt, samples: series.length, series: series.slice(-6), thumbRequests: thumbLog }, null, 2))
await app.close()
