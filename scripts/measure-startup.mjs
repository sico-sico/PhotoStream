#!/usr/bin/env node
/**
 * Measure cold-start timing.
 *
 * Startup is three costs stacked: Chromium's own boot, the window+React mount,
 * and the work that follows (scanning the restored folder, then the first
 * screenful of thumbnails). Only the last two are ours, and they are small
 * enough that a change needs measurement to be believed rather than guessed at.
 *
 * Reports the median of `runs` launches, both with an empty library (no folder
 * to restore) and with a folder that is restored from `settings.json`.
 *
 * Usage: node scripts/measure-startup.mjs [photoDir] [runs]
 *   Requires `npm run build` first; the default entry point is `out/main`.
 *   PS_EXE=<packaged exe> measures a packaged build instead, which is the number
 *   that matters: an asar bundle and an unpacked native module have their own
 *   costs.
 */
import { _electron as electron } from 'playwright'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const photoDir = process.argv[2]
const runs = Number(process.argv[3] ?? 5)

async function launch({ withPhotos, userDataDir }) {
  const dataDir = join(userDataDir, 'PhotoStreamData')
  await mkdir(dataDir, { recursive: true })
  await writeFile(
    join(dataDir, 'settings.json'),
    JSON.stringify({
      lastDir: withPhotos ? photoDir : '',
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

  const target = process.env.PS_EXE
    ? { executablePath: process.env.PS_EXE }
    : { args: [join(process.cwd(), 'out', 'main', 'index.js')] }

  const started = performance.now()
  const app = await electron.launch({ ...target, env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir } })
  const page = await app.firstWindow()
  const windowAt = performance.now()
  await page.waitForLoadState('domcontentloaded')
  const domAt = performance.now()

  const main = await app.evaluate(() => ({
    uptimeMs: Math.round(process.uptime() * 1000),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
  }))

  let tileAt = null
  let imageAt = null
  if (withPhotos) {
    await page.waitForSelector('[data-photo-id]', { timeout: 120_000 })
    tileAt = performance.now()
    await page.waitForFunction(
      () => {
        const image = document.querySelector('[data-photo-id] img')
        return Boolean(image && image.complete && image.naturalWidth > 0)
      },
      { timeout: 120_000 }
    )
    imageAt = performance.now()
  }

  const renderer = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0]
    return {
      domContentLoaded: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
      nodes: document.querySelectorAll('*').length,
      tiles: document.querySelectorAll('[data-photo-id]').length
    }
  })

  await app.close()

  return {
    window: Math.round(windowAt - started),
    dom: Math.round(domAt - started),
    tile: tileAt === null ? null : Math.round(tileAt - started),
    image: imageAt === null ? null : Math.round(imageAt - started),
    mainUptime: main.uptimeMs,
    mainRssMb: main.rssMb,
    rendererDomMs: renderer.domContentLoaded,
    tiles: renderer.tiles,
    nodes: renderer.nodes
  }
}

function median(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b)
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]
}

async function report(label, options) {
  // One data directory for the whole series, not one per launch: the numbers
  // being compared are "launch again with everything already cached", which is
  // what a user experiences. A fresh directory would measure thumbnail encoding
  // on every run instead.
  const userDataDir = await mkdtemp(join(tmpdir(), 'photostream-startup-'))
  // Discarded warm-up: the first launch populates the metadata and thumbnail
  // caches, so its timing describes the cold case rather than the median.
  await launch({ ...options, userDataDir })

  const samples = []
  for (let index = 0; index < runs; index++) samples.push(await launch({ ...options, userDataDir }))
  const columns = ['window', 'dom', 'tile', 'image', 'mainUptime', 'mainRssMb', 'nodes', 'tiles']
  const summary = Object.fromEntries(columns.map((column) => [column, median(samples.map((sample) => sample[column]))]))
  console.log(`${label} (median of ${runs})`)
  for (const [column, value] of Object.entries(summary)) console.log(`  ${column.padEnd(12)} ${value}`)
}

await report('empty library', { withPhotos: false })
if (photoDir) await report(`restored ${photoDir}`, { withPhotos: true })
else console.log('\npass a photo directory to also measure the restore path')
