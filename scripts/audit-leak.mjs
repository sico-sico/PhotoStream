// Does renderer memory plateau, or does it keep growing with use?
//
// A one-off growth number is not evidence of a leak: the first pass over a
// library legitimately decodes and caches bitmaps. What matters is whether
// repeating the same gesture keeps adding memory, which no amount of caching
// should do.
//
// Usage: node scripts/audit-leak.mjs <photoDir> [rounds]
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [photoDir, roundsArg] = process.argv.slice(2)
if (!photoDir) {
  console.error('usage: node scripts/audit-leak.mjs <photoDir> [rounds]')
  process.exit(1)
}
const rounds = Number(roundsArg ?? 6)

const userDataDir = await mkdtemp(join(tmpdir(), 'photostream-leak-'))
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
await page.waitForTimeout(4000)

/** Renderer-specific heap via the DevTools protocol, which is far less noisy than workingSetSize. */
async function rendererHeapMB() {
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.collectGarbage')
  const { usedSize } = await session.send('Runtime.getHeapUsage')
  await session.detach()
  return Math.round((usedSize / (1024 * 1024)) * 10) / 10
}

/** One round: open/close every tile on screen, then pan and come back. */
async function oneRound(index) {
  for (let i = 0; i < 6; i += 1) {
    await page.locator('[data-photo-id]').nth(i).click()
    await page.waitForTimeout(150)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
  }
  // Pan down and back, which mounts a different culled set.
  const stage = await page.getByTestId('stage').boundingBox()
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await page.mouse.wheel(0, 1800)
  await page.waitForTimeout(500)
  await page.mouse.wheel(0, -1800)
  await page.waitForTimeout(500)
  void index
}

const samples = []
samples.push({ round: 0, heapMB: await rendererHeapMB() })

for (let round = 1; round <= rounds; round += 1) {
  await oneRound(round)
  await page.waitForTimeout(600)
  samples.push({ round, heapMB: await rendererHeapMB() })
}

// Let it idle: caches should settle, and a leak will still be there.
await page.waitForTimeout(4000)
samples.push({ round: 'idle', heapMB: await rendererHeapMB() })

const first = samples[1].heapMB
const last = samples[samples.length - 1].heapMB
console.log(
  JSON.stringify(
    {
      samples,
      growthFromFirstRoundMB: Math.round((last - first) * 10) / 10,
      growthPerRoundMB: Math.round(((last - first) / rounds) * 10) / 10
    },
    null,
    2
  )
)

await app.close()
