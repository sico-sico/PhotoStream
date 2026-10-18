// Measure how the wall behaves during zoom gestures.
//
// Two probes, because the zoom path had two distinct problems:
//   requests — how many rendition requests each zoom cycle triggers, by level.
//              A healthy gesture stays on the cached levels; reaching `full`
//              means decoding multi-megapixel originals per frame.
//   memory   — renderer and GPU memory before, during and after zooming in and
//              back out. Memory must come back down; if it does not, tiles are
//              pinned to whatever was sharpest rather than what the zoom wants.
//
// Usage:
//   node scripts/measure-zoom.mjs requests "D:\photos"
//   node scripts/measure-zoom.mjs memory   "D:\photos"
//
// Requires `npm run build` first: it drives the built entry point.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [mode, photoDir] = process.argv.slice(2)
if (!mode || !photoDir || !['requests', 'memory'].includes(mode)) {
  console.error('usage: node scripts/measure-zoom.mjs <requests|memory> <photoDir>')
  process.exit(1)
}

const userDataDir = await mkdtemp(join(tmpdir(), `photostream-zoom-${mode}-`))
const dataDir = join(userDataDir, 'PhotoStreamData')
await mkdir(dataDir, { recursive: true })
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify(
    {
      lastDir: photoDir,
      layout: 'grid',
      sort: 'taken-desc',
      filters: { from: '', to: '', text: '' },
      locale: 'en',
      history: []
    },
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

/** Zoom in `inSteps` wheel notches, then the same out. */
async function cycle(inSteps, outSteps, settleMs = 0) {
  for (let i = 0; i < inSteps; i += 1) await page.mouse.wheel(0, -200)
  if (settleMs) await page.waitForTimeout(settleMs)
  for (let i = 0; i < outSteps; i += 1) await page.mouse.wheel(0, 200)
  if (settleMs) await page.waitForTimeout(settleMs)
}

if (mode === 'requests') {
  await page.evaluate(() => {
    window.__probe = { byLevel: { wall: 0, zoom: 0, full: 0 }, lastAt: Date.now(), gaps: [] }
    window.photoStream.onThumbReady(([, , level]) => {
      const p = window.__probe
      p.byLevel[level] += 1
      const now = Date.now()
      p.gaps.push(now - p.lastAt)
      p.lastAt = now
    })
  })

  for (let i = 0; i < 3; i += 1) await cycle(8, 8, 120)
  // Let the queues drain so the counts cover the whole burst.
  await page.waitForTimeout(9000)

  const result = await page.evaluate(() => {
    const p = window.__probe
    const sorted = [...p.gaps].sort((a, b) => a - b)
    return {
      byLevel: p.byLevel,
      total: p.gaps.length,
      medianGapMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      maxGapMs: sorted.length ? sorted[sorted.length - 1] : 0,
      tilesMounted: document.querySelectorAll('[data-photo-id]').length,
      tilesWithSrc: document.querySelectorAll('[data-photo-id] img[src^="pic://"]').length
    }
  })
  console.log(JSON.stringify(result, null, 2))
} else {
  const sample = async (label) => {
    const tiles = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('[data-photo-id] img')]
      const sources = imgs.map((img) => img.getAttribute('src') ?? '')
      return {
        tiles: imgs.length,
        fullCount: sources.filter((s) => s.includes('/photo/')).length,
        thumbCount: sources.filter((s) => s.includes('/thumb/')).length
      }
    })
    const processes = await app.evaluate(async ({ app: electronApp }) =>
      electronApp.getAppMetrics().map((m) => ({ type: m.type, mb: Math.round((m.memory?.workingSetSize ?? 0) / 1024) }))
    )
    console.log(label, JSON.stringify({ ...tiles, processes }))
  }

  await sample('baseline            ')
  await cycle(10, 0, 6000)
  await sample('after zoom-in       ')
  await cycle(0, 12, 6000)
  await sample('after zoom-out      ')
  for (let i = 0; i < 2; i += 1) await cycle(10, 12, 2500)
  await page.waitForTimeout(4000)
  await sample('after 2 more cycles ')
}

await app.close()
