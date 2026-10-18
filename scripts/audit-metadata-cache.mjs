// Does the metadata cache survive switching between folders?
//
// Measured on the 3226-photo sample: opening a folder spends 1178 ms of 1296 ms
// reading EXIF, and the cache exists to make a repeat visit cheap. `retain()`
// prunes every row that is not in the folder that was just scanned, so the
// question is whether that pruning throws away a different folder's rows — which
// would make the cache useless precisely for the history menu, whose whole point
// is switching back and forth.
//
// Usage: node scripts/audit-metadata-cache.mjs <photoDirA> <photoDirB>
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [dirA, dirB] = process.argv.slice(2)
if (!dirA || !dirB) {
  console.error('usage: node scripts/audit-metadata-cache.mjs <photoDirA> <photoDirB>')
  process.exit(1)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'photostream-meta-'))
const dataDir = join(userDataDir, 'PhotoStreamData')
await mkdir(dataDir, { recursive: true })
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify(
    { lastDir: dirA, layout: 'grid', sort: 'taken-desc', filters: { from: '', to: '', text: '' }, locale: 'en', history: [], recursive: false },
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

/** Time an open, as the renderer experiences it (IPC round trip included). */
async function timedOpen(dir) {
  return page.evaluate(async (target) => {
    const started = performance.now()
    const result = await window.photoStream.openDirectory(target, false)
    return { ms: Math.round(performance.now() - started), photos: result.photos.length }
  }, dir)
}

const runs = []
// Cold A (first scan ever for these files).
runs.push({ label: 'A cold', ...(await timedOpen(dirA)) })
await page.waitForTimeout(300)
// B, which was never scanned.
runs.push({ label: 'B cold', ...(await timedOpen(dirB)) })
await page.waitForTimeout(300)
// Back to A. If `retain` wiped A's rows while scanning B, this is cold again.
runs.push({ label: 'A again', ...(await timedOpen(dirA)) })
await page.waitForTimeout(300)
runs.push({ label: 'A twice', ...(await timedOpen(dirA)) })
await page.waitForTimeout(300)
runs.push({ label: 'B again', ...(await timedOpen(dirB)) })

console.log(JSON.stringify({ runs }, null, 2))
await app.close()
