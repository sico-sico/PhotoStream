// Verify the two scrollbar drag complaints against a real window.
//
// 1. Clicking the track at the top of the page must not make the wall scroll
//    away from the click.
// 2. Grabbing the thumb while at the bottom must start scrolling immediately,
//    not only after the pointer has travelled back some distance.
//
// Usage: node scripts/verify-scrollbar.mjs <photoDir>
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const photoDir = process.argv[2]
if (!photoDir) {
  console.error('usage: node scripts/verify-scrollbar.mjs <photoDir>')
  process.exit(1)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'photostream-sb-'))
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
  env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForSelector('[data-photo-id]', { timeout: 120_000 })
await page.waitForTimeout(3000)

const bar = page.getByTestId('wall-scrollbar')
await bar.waitFor({ state: 'visible' })
const track = await bar.boundingBox()
const worldY = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="world"]')
    const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform)
    return m ? Math.round(Number(m[2])) : 0
  })

const results = {}

// --- 1. track click at the very top: must land at the top, not scroll away ---
await bar.focus()
await page.keyboard.press('End') // go to the bottom first, so a click has room
await page.waitForTimeout(600)
const beforeTopClick = await worldY()

await page.mouse.move(track.x + track.width / 2, track.y + 2)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(600)
const afterTopClick = await worldY()

results.trackClickAtTop = {
  before: beforeTopClick,
  after: afterTopClick,
  landedNearTop: afterTopClick > -50,
  note: 'clicking 2px from the top should jump to the first row'
}

// --- 2. grab the thumb at the bottom and move up 10px: must move immediately ---
await page.keyboard.press('End')
await page.waitForTimeout(600)
const bottomY = await worldY()

const thumb = await page.locator('.scrollbar-thumb').boundingBox()
// Grab near the bottom edge of the thumb, the case that used to feel stuck.
const grabY = thumb.y + thumb.height - 3
await page.mouse.move(track.x + track.width / 2, grabY)
await page.mouse.down()
await page.mouse.move(track.x + track.width / 2, grabY - 10, { steps: 3 })
await page.waitForTimeout(300)
const afterSmallDrag = await worldY()
await page.mouse.up()

results.smallDragFromBottom = {
  bottom: bottomY,
  after10px: afterSmallDrag,
  movedImmediately: afterSmallDrag > bottomY + 20,
  delta: afterSmallDrag - bottomY,
  note: 'a 10px upward drag must scroll a little, not be swallowed by the grab offset'
}

console.log(JSON.stringify(results, null, 2))
await app.close()
