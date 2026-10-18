// Does the show actually advance on its own, pause on hover, and turn over?
//
// Unit tests drive `advance` with a fake clock; this checks the wiring in a real
// window — that the interval really fires, that hover really holds it, and that
// the ring really is replaced after a minute.
//
// Usage: node scripts/verify-random-timing.mjs <photoDir>
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const photoDir = process.argv[2]
if (!photoDir) {
  console.error('usage: node scripts/verify-random-timing.mjs <photoDir>')
  process.exit(1)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'photostream-timing-'))
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

await page.getByRole('button', { name: 'Random show' }).click()
await page.getByTestId('random-centre').waitFor({ state: 'visible', timeout: 10_000 })
await page.waitForTimeout(1500)

const centreSrc = () => page.getByTestId('random-centre').locator('img').getAttribute('src')
const ringIds = () =>
  page.$$eval('[data-testid="random-thumb"]', (els) => els.map((el) => el.getAttribute('data-photo-id')))

/** Wait until the centre photo's thumbnail changes, or time out. */
async function waitForCentreChange(previous, timeout) {
  try {
    await page.waitForFunction(
      (src) => {
        const img = document.querySelector('[data-testid="random-centre"] img')
        return img !== null && img.getAttribute('src') !== src
      },
      previous,
      { timeout }
    )
    return true
  } catch {
    return false
  }
}

// --- 1. auto-advance: the centre changes with no input at all ---------------
const startedSrc = await centreSrc()
const advanced = await waitForCentreChange(startedSrc, 12_000)

// --- 2. hover holds it still ------------------------------------------------
await page.getByTestId('random-thumb').nth(0).hover()
const heldSrc = await centreSrc()
// Longer than the 8 s interval: without the pause this would have changed.
await page.waitForTimeout(11_000)
const stillHeld = (await centreSrc()) === heldSrc
const pauseHintVisible = await page
  .getByText(/paused/i)
  .isVisible()
  .catch(() => false)

// --- 3. the ring turns over after a minute ----------------------------------
await page.mouse.move(4, 4)
await page.waitForTimeout(500)
const ringBefore = await ringIds()
let turnedOver = false
try {
  await page.waitForFunction(
    (previous) => {
      const now = Array.from(document.querySelectorAll('[data-testid="random-thumb"]')).map((el) =>
        el.getAttribute('data-photo-id')
      )
      if (now.length === 0) return false
      // A turnover replaces the ring; a promotion keeps almost all of it.
      const kept = now.filter((id) => previous.includes(id)).length
      return kept < previous.length * 0.34
    },
    ringBefore,
    { timeout: 75_000 }
  )
  turnedOver = true
} catch {
  turnedOver = false
}
const ringAfter = await ringIds()

console.log(
  JSON.stringify(
    {
      autoAdvance: { changedWithoutInput: advanced },
      hoverPause: { unchangedAfter11s: stillHeld, hintVisible: pauseHintVisible },
      turnover: {
        happened: turnedOver,
        ringSizeBefore: ringBefore.length,
        ringSizeAfter: ringAfter.length,
        overlap: ringAfter.filter((id) => ringBefore.includes(id)).length
      }
    },
    null,
    2
  )
)

await app.close()
await rm(userDataDir, { recursive: true, force: true })
