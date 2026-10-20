#!/usr/bin/env node
/**
 * Measure "open this folder" → first tile, through the real UI path.
 *
 * Separate from `measure-startup.mjs` on purpose: startup restores a folder the
 * main process already prefetched, so it never exercises the cache-seeded path
 * that a user-initiated open (folder picker, history menu, drop) uses.
 *
 * The first launch warms the metadata cache; the measured launches then open the
 * same folder with the picker stubbed. Reports click→first-tile, which is the
 * latency the user actually experiences, and the click's own round trip, which
 * shows whether the main process stayed responsive.
 *
 * Usage: node scripts/measure-open.mjs <photoDir> [runs]
 *   Requires `npm run build` first.
 */
import { _electron as electron } from 'playwright'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const [photoDir, runsArg] = process.argv.slice(2)
const runs = Number(runsArg ?? 5)
const userDataDir = await mkdtemp(join(tmpdir(), 'ps-open-ab-'))
const dataDir = join(userDataDir, 'PhotoStreamData')
await mkdir(dataDir, { recursive: true })
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify({
    lastDir: '',
    layout: 'grid',
    sort: 'taken-desc',
    filters: { from: '', to: '', text: '' },
    locale: 'en',
    history: [],
    recursive: false,
    viewerInfo: false,
    ringSize: 70,
    cacheBudgetMb: 0
  }),
  'utf-8'
)

async function launch() {
  const app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js')],
    env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function warm() {
  await resetSettings()
  const { app, page } = await launch()
  await page.evaluate((dir) => window.photoStream.openDirectory(dir, false), photoDir)
  await page.waitForTimeout(2000)
  await app.close()
}

async function resetSettings() {
  // The renderer persists `lastDir` as soon as a folder is open, so it has to be
  // cleared again before every measured launch. The metadata database next to it
  // is left alone: that is the warm cache being tested.
  await writeFile(
    join(dataDir, 'settings.json'),
    JSON.stringify({
      lastDir: '',
      layout: 'grid',
      sort: 'taken-desc',
      filters: { from: '', to: '', text: '' },
      locale: 'en',
      history: [],
      recursive: false,
      viewerInfo: false,
      ringSize: 70,
      cacheBudgetMb: 0
    }),
    'utf-8'
  )
}

async function measure() {
  await resetSettings()
  const { app, page } = await launch()
  // `attached` rather than the default `visible`: the empty state is mounted but
  // sits under the drag overlay, which Playwright's visibility check rejects.
  await page.waitForSelector('.empty-state button.primary', { state: 'attached', timeout: 60_000 })
  // No OS picker can be clicked from here; stubbing it keeps the whole real path
  // (renderer -> IPC -> scan -> pic://) intact.
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, photoDir)

  const started = performance.now()
  await page.locator('.empty-state button.primary').click({ force: true })
  const clicked = performance.now()
  await page.waitForSelector('[data-photo-id]', { timeout: 300_000 })
  const tileAt = performance.now()
  const tiles = await page.locator('[data-photo-id]').count()
  await app.close()
  return { clicked: Math.round(clicked - started), tile: Math.round(tileAt - started), tiles }
}

await warm()
const results = []
for (let index = 0; index < runs; index++) {
  const result = await measure()
  results.push(result)
  console.log('run', index, JSON.stringify(result))
}
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
console.log(
  'median',
  JSON.stringify({
    clickRoundTrip: median(results.map((r) => r.clicked)),
    clickToFirstTile: median(results.map((r) => r.tile))
  })
)
