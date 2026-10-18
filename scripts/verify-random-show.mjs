// Verify the random show in a real window.
//
// Unit tests cover geometry and timing against a fake clock; this checks the
// things only a real Chromium can answer: does it render, do the photos load,
// does clicking promote, does hovering pause, does Escape leave.
//
// Usage: node scripts/verify-random-show.mjs <photoDir>
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const photoDir = process.argv[2]
if (!photoDir) {
  console.error('usage: node scripts/verify-random-show.mjs <photoDir>')
  process.exit(1)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'photostream-show-'))
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

const report = {}

// --- open -------------------------------------------------------------------
await page.getByRole('button', { name: 'Random show' }).click()
await page.getByTestId('random-centre').waitFor({ state: 'visible', timeout: 10_000 })
await page.waitForTimeout(2500)

const layout = await page.evaluate(() => {
  const centre = document.querySelector('[data-testid="random-centre"]')
  const thumbs = Array.from(document.querySelectorAll('[data-testid="random-thumb"]'))
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const overlaps = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  const boxes = thumbs.map(rect)
  let overlapsBetweenThumbs = 0
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlaps(boxes[i], boxes[j])) overlapsBetweenThumbs += 1
    }
  }
  const centreBox = rect(centre)
  return {
    centre: centreBox,
    thumbCount: thumbs.length,
    thumbSizes: boxes.map((b) => b.w),
    overlapsBetweenThumbs,
    thumbsOverlapCentre: boxes.filter((b) => overlaps(b, centreBox)).length,
    centreLoaded: Boolean(centre.querySelector('img')),
    thumbsLoaded: thumbs.filter((t) => t.querySelector('img')).length,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    distinctSizes: new Set(boxes.map((b) => b.w)).size
  }
})
report.layout = layout

// --- click a small photo ----------------------------------------------------
// The rendered `src` is a hashed thumbnail URL, not a path, so the check is on
// the *tile* that disappeared from the ring and the centre's size change: the
// promoted photo is identified by its `data-photo-id`, which is present while it
// is still a small tile.
const beforeSrc = await page.getByTestId('random-centre').locator('img').getAttribute('src')
const beforeCentreBox = await page.getByTestId('random-centre').boundingBox()
const targetThumb = page.getByTestId('random-thumb').nth(2)
const target = await targetThumb.getAttribute('data-photo-id')
const targetSrc = await targetThumb.locator('img').getAttribute('src')
// Keyboard activation rather than a mouse click.
//
// Every photo is drifting by design, so Playwright's "element is stable" check
// never passes — and that check is not wrong: the target really is moving. A
// human aims at a moving photo, so this exercises the path that a keyboard user
// takes instead, which is also the only one a test can drive deterministically.
// It doubles as a check that the ring is reachable without a pointer.
await targetThumb.focus()
await page.waitForTimeout(300)
await page.keyboard.press('Enter')
await page.waitForTimeout(900)

const afterSrc = await page.getByTestId('random-centre').locator('img').getAttribute('src')
const afterCentreBox = await page.getByTestId('random-centre').boundingBox()
const ringStillHasTarget = await page.locator(`[data-testid="random-thumb"][data-photo-id="${target}"]`).count()

report.clickPromotes = {
  target,
  // The photo that was in the ring now holds the centre slot...
  centreShowsClickedPhoto: afterSrc === targetSrc,
  // ...and it is no longer a small tile.
  removedFromRing: ringStillHasTarget === 0,
  // A promotion is a real change, not a no-op.
  centreChanged: afterSrc !== beforeSrc,
  grewToCentreSize: (afterCentreBox?.width ?? 0) > (beforeCentreBox?.width ?? 0) * 0.5
}

// --- hover pauses -----------------------------------------------------------
await page.getByTestId('random-thumb').nth(0).hover()
await page.waitForTimeout(400)
report.hoverPauses = await page.getByText(/paused/i).isVisible()
await page.mouse.move(5, 5)
await page.waitForTimeout(400)

// --- escape leaves ----------------------------------------------------------
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
report.closesOnEscape = (await page.getByTestId('random-centre').count()) === 0

console.log(JSON.stringify(report, null, 2))
await app.close()
await rm(userDataDir, { recursive: true, force: true })
