import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

/**
 * End-to-end coverage of the whole app.
 *
 * A real Electron process is launched against a temporary photo library so the
 * tests exercise the actual IPC bridge, the `pic://` protocol, sharp-based
 * thumbnail generation and the renderer, rather than mocks of them.
 */

let app: ElectronApplication
let page: Page
let userDataDir: string
let photoDir: string

/** The app stores its files in `PhotoStreamData` under the override root. */
const dataDir = (): string => join(userDataDir, 'PhotoStreamData')

/**
 * Seed settings before launch.
 *
 * The UI follows the OS language by default, which is correct behaviour but
 * makes text assertions depend on the machine running the tests. Writing an
 * explicit English preference keeps the suite deterministic while still going
 * through the real settings-file path.
 */
async function seedSettings(locale: string): Promise<void> {
  await mkdir(dataDir(), { recursive: true })
  await writeFile(
    join(dataDir(), 'settings.json'),
    JSON.stringify({ lastDir: '', layout: 'grid', filters: { from: '', to: '', text: '' }, locale }, null, 2),
    'utf-8'
  )
}

/** Write a JPEG with a real EXIF capture date. */
async function writeJpeg(dir: string, name: string, date: string, width = 320, height = 200): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .withExif({ IFD0: { DateTime: date }, IFD3: { DateTimeOriginal: date } })
    .jpeg()
    .toFile(join(dir, name))
}

test.beforeAll(async () => {
  photoDir = await mkdtemp(join(tmpdir(), 'photostream-e2e-photos-'))
  userDataDir = await mkdtemp(join(tmpdir(), 'photostream-e2e-data-'))

  // The first photo is deliberately larger than the window: the viewer only
  // allows panning once the photo overflows the stage, so a small fixture could
  // never exercise a drag.
  await writeJpeg(photoDir, '2019-07-14 Kyoto.jpg', '2019:07:14 08:15:00', 2400, 1600)
  await writeJpeg(photoDir, '2020-01-05 Paris.jpg', '2020:01:05 19:30:00')
  await writeJpeg(photoDir, '2024-03-11 Osaka.jpg', '2024:03:11 23:45:00', 200, 300)

  // A handful of extra photos so the wall is taller and wider than the window.
  // With only three, the fitted wall fits both axes and the pan bounds correctly
  // pin it in place - leaving nothing for the panning tests to scroll to. They
  // are dated 2018 so they sort after (and filter outside) the named photos.
  for (let index = 0; index < 12; index += 1) {
    const day = String(index + 1).padStart(2, '0')
    await writeJpeg(photoDir, `2018-02-${day} Extra ${index}.jpg`, `2018:02:${day} 12:00:00`)
  }

  await seedSettings('en')

  app = await electron.launch({
    // Launch the built entry point, so this asserts what actually ships.
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      // Keep every test run hermetic: no settings, no thumbnail cache reuse.
      PHOTOSTREAM_USER_DATA: userDataDir
    }
  })

  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

/**
 * All tests share one Electron instance for speed, so they must run in order
 * and must not assume a pristine UI: earlier tests switch layouts and
 * languages. `serial` makes that contract explicit, and each test starts from
 * the state it needs rather than from whatever the previous one left behind.
 */
test.describe.configure({ mode: 'serial' })

test.afterAll(async () => {
  await app?.close()
  await rm(photoDir, { recursive: true, force: true })
  await rm(userDataDir, { recursive: true, force: true })
})

/** Return the UI to English before asserting on English labels. */
/**
 * Pick a language through the gear menu.
 *
 * The picker is no longer permanently visible: preferences live behind the gear,
 * so every language switch has to open the menu first. Located by class because
 * the accessible name is itself translated.
 */
async function chooseLanguage(id: string): Promise<void> {
  await page.locator('.menu-trigger').click()
  await page.locator('.settings-menu select').selectOption(id)
  // Selecting closes the menu, which also keeps later clicks unobstructed.
  await expect(page.locator('.menu-panel')).toHaveCount(0)
}

async function useEnglish(): Promise<void> {
  // Idempotent on purpose: a previous test may have left the menu open, and
  // clicking the trigger again would close it, making the picker disappear and
  // the next lookup time out. Open it only when it is actually closed.
  if ((await page.locator('.settings-menu').count()) === 0) await page.locator('.menu-trigger').click()

  const picker = page.locator('.settings-menu select')
  await expect(picker).toBeVisible()
  const current = await picker.inputValue()
  // Escape rather than select when nothing needs changing, so the state is left
  // exactly as it was.
  if (current !== 'en') await picker.selectOption('en')
  else await page.keyboard.press('Escape')
  await expect(page.locator('.menu-panel')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()
}

/**
 * Zoom the wall with Ctrl+wheel.
 *
 * A bare wheel pans now, matching every other viewer; zooming needs the
 * modifier. Playwright's `mouse.wheel` cannot set `ctrlKey`, so the keyboard is
 * held around the scroll.
 */
async function zoomWall(deltaY: number): Promise<void> {
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, deltaY)
  await page.keyboard.up('Control')
}

/**
 * Open a specific photo by file-name fragment.
 *
 * Viewer tests need a known photo rather than "whatever is first": the wall is
 * newest-first, and the fixtures differ in size and orientation. The tile's text
 * is only the capture date, so the file name is matched through the image's
 * `alt`, case-insensitively (the id itself is a lowercased path).
 */
async function openPhoto(nameFragment: string): Promise<void> {
  await page.locator(`[data-photo-id]:has(img[alt*="${nameFragment}" i])`).first().click()
}

/**
 * Open the seeded photo folder through the stubbed native dialog.
 *
 * Works from either state: on a cold start the empty state's primary button is
 * the visible call to action, but mid-suite the wall already has content and
 * only the toolbar button exists.
 *
 * The assertion names the folder rather than an absolute photo count. One test
 * in this suite drops a new file into the library and the watcher keeps it, so
 * the total legitimately grows during the run; pinning `15/15` here made every
 * later call fail for a reason unrelated to what it was testing.
 */
async function openLibrary(): Promise<void> {
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, photoDir)

  await useEnglish()

  const emptyAction = page.locator('.empty-state button.primary')
  if ((await emptyAction.count()) > 0) await emptyAction.click()
  else await page.getByRole('button', { name: 'Open folder…' }).click()

  await expect(page.locator('.dir-label')).toHaveText(photoDir)
  // Tiles are culled to the viewport, so the count comes from the toolbar's
  // total rather than from the DOM.
  await expect(page.locator('.photo-count')).not.toHaveText('0/0')
}

test('boots with the seeded English language', async () => {
  // The UI follows the OS language unless a preference is stored; the suite
  // seeds `en` so this asserts the settings path, not the host machine.
  await expect(page.getByRole('heading', { name: 'PhotoStream' })).toBeVisible()
  expect(await page.locator('html').getAttribute('lang')).toBe('en')

  // The empty state and the toolbar both offer the action; assert both exist
  // rather than fighting Playwright's strict single-element mode.
  await expect(page.getByRole('button', { name: /open folder/i })).toHaveCount(2)
  await expect(page.locator('.empty-state')).toBeVisible()
})

test('opens a folder and builds the wall from EXIF dates', async () => {
  await openLibrary()

  // Order comes from EXIF capture dates, newest first - not from file names.
  const captions = page.locator('.tile-caption')
  await expect(captions.nth(0)).toHaveText('2024-03-11')
  await expect(captions.nth(1)).toHaveText('2020-01-05')
  await expect(captions.nth(2)).toHaveText('2019-07-14')
  // The 2018 filler photos come last.
  await expect(captions.nth(3)).toHaveText('2018-02-12')
})

test('reorders the wall when the sort mode changes', async () => {
  await useEnglish()
  const captions = page.locator('.tile-caption')
  const trigger = page.getByRole('button', { name: 'Sort order' })

  // The trigger states the active ordering, so the default is visible without
  // opening the panel.
  await expect(trigger).toHaveText(/Newest first/)
  await expect(captions.nth(0)).toHaveText('2024-03-11')

  const choose = async (label: string): Promise<void> => {
    await trigger.click()
    await page.getByRole('menuitemradio', { name: label }).click()
    // Choosing closes the panel, which also keeps later clicks unobstructed.
    await expect(page.getByRole('menu')).toHaveCount(0)
  }

  await choose('Oldest first')
  await expect(captions.nth(0)).toHaveText('2018-02-01')
  await choose('Name A→Z')
  await expect(captions.nth(0)).toHaveText('2018-02-01')
  await choose('Name Z→A')
  await expect(captions.nth(0)).toHaveText('2024-03-11')

  // Back to the default so later tests see the documented order.
  await choose('Newest first')
  await expect(captions.nth(0)).toHaveText('2024-03-11')
})

test('renders generated thumbnails through the pic protocol', async () => {
  await useEnglish()
  const images = page.locator('[data-photo-id] img')
  await expect(images.first()).toHaveAttribute('src', /^pic:\/\/thumb\//)

  // A broken protocol surfaces as a natural-width of 0.
  await expect
    .poll(async () => images.first().evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
})

test('switches between the three layouts', async () => {
  await useEnglish()
  for (const label of ['Masonry', 'Square', 'Rows']) {
    await page.getByRole('button', { name: label }).click()
    await expect(page.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.photo-count')).toHaveText('15/15')
  }
})

test('filters by file name and resets', async () => {
  await useEnglish()
  await page.getByRole('button', { name: 'Filters' }).click()

  await page.getByLabel('File name').fill('Kyoto')
  await expect(page.locator('.photo-count')).toHaveText('1/15')

  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page.locator('.photo-count')).toHaveText('15/15')

  await page.getByRole('button', { name: 'Filters' }).click()
})

test('filters by file name with wildcards', async () => {
  await useEnglish()
  await page.getByRole('button', { name: 'Filters' }).click()
  const field = page.getByLabel('File name')

  // `*` spans any run of characters, anchored to the whole name. The fixtures
  // are named like `2018-02-05 Extra 4.jpg`, so this selects all twelve of them.
  await field.fill('2018-*Extra*')
  await expect(page.locator('.photo-count')).toHaveText('12/15')

  // `?` matches exactly one character: only the single-digit days match.
  await field.fill('2018-02-0? *')
  await expect(page.locator('.photo-count')).toHaveText('9/15')

  // An extension pattern selects everything, and a wrong extension nothing.
  await field.fill('*.jpg')
  await expect(page.locator('.photo-count')).toHaveText('15/15')
  await field.fill('*.png')
  await expect(page.locator('.photo-count')).toHaveText('0/15')

  // Without a wildcard the match is a substring again, not an exact name.
  await field.fill('Kyoto')
  await expect(page.locator('.photo-count')).toHaveText('1/15')

  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page.locator('.photo-count')).toHaveText('15/15')
  await page.getByRole('button', { name: 'Filters' }).click()
})

test('filters by capture date range', async () => {
  await useEnglish()
  await page.getByRole('button', { name: 'Filters' }).click()

  // From 2020-01-01: Paris (2020-01-05) and Osaka (2024-03-11).
  await page.getByLabel('Date from').fill('2020-01-01')
  await expect(page.locator('.photo-count')).toHaveText('2/15')

  // Up to 2024-01-01 leaves only Paris.
  await page.getByLabel('Date to').fill('2024-01-01')
  await expect(page.locator('.photo-count')).toHaveText('1/15')

  await page.getByRole('button', { name: 'Reset' }).click()
  await page.getByRole('button', { name: 'Filters' }).click()
})

test('zooms with the wheel and pans by dragging', async () => {
  await useEnglish()
  // Reset to a fitted wall first: earlier tests leave it panned against an edge,
  // where the bounds correctly refuse further movement in that direction.
  await page.getByRole('button', { name: 'Square' }).click()
  await page.getByRole('button', { name: 'Rows' }).click()

  const world = page.locator('[data-testid="world"]')
  await expect(page.locator('[data-photo-id]').first()).toBeVisible()
  const before = await world.evaluate((el: HTMLElement) => el.style.transform)

  await page.mouse.move(600, 400)
  await zoomWall(-400)
  await expect.poll(async () => world.evaluate((el: HTMLElement) => el.style.transform)).not.toBe(before)

  const afterZoom = await world.evaluate((el: HTMLElement) => el.style.transform)

  // Zoom in again, so the wall is larger than the window on both axes and the
  // drag below has somewhere to go. With only three photos the wall fits
  // vertically after a single zoom step, and the bounds then correctly pin it.
  await zoomWall(-600)
  await page.waitForTimeout(500)

  await page.mouse.move(600, 400)
  await page.mouse.down()
  await page.mouse.move(700, 480, { steps: 8 })
  await page.mouse.up()

  const afterDrag = await world.evaluate((el: HTMLElement) => el.style.transform)
  expect(afterDrag).not.toBe(afterZoom)
})

test('pans the wall with the arrow keys', async () => {
  await useEnglish()
  // A zoomed-in view is required: with only three fixtures the fitted wall is
  // smaller than the window on both axes, and the bounds then correctly pin it
  // in place — there is nothing off screen to scroll to.
  await page.getByRole('button', { name: 'Rows' }).click()
  const world = page.locator('[data-testid="world"]')
  await expect(page.locator('[data-photo-id]').first()).toBeVisible()

  const stage = (await page.getByTestId('stage').boundingBox())!
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  for (let i = 0; i < 3; i += 1) await zoomWall(-400)
  await page.waitForTimeout(700)

  const yOf = () =>
    world.evaluate((el: HTMLElement) => {
      const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform)
      return m ? Math.round(Number(m[2])) : 0
    })

  // Back to the top first, so a downward step has room to travel.
  await page.keyboard.press('Shift+ArrowUp')
  await page.keyboard.press('Shift+ArrowUp')
  await page.waitForTimeout(400)

  const startY = await yOf()
  await page.keyboard.press('ArrowDown')
  const afterDown = await yOf()
  expect(afterDown).toBeLessThan(startY)

  // Shift takes a much larger step in the same direction.
  await page.keyboard.press('Shift+ArrowDown')
  expect(await yOf()).toBeLessThan(afterDown)
})

test('arrow keys pan the wall even after a photo has been viewed', async () => {
  await useEnglish()

  // Return to a usable view: earlier tests leave the wall zoomed and panned, and
  // a culled wall has no tiles to click. Switching layouts changes the fit key.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Square' }).click()
  await page.getByRole('button', { name: 'Rows' }).click()
  await expect(page.locator('[data-photo-id]').first()).toBeVisible()

  // Viewing a photo leaves it focused. This used to hijack the arrow keys: they
  // walked the selection instead of panning, so the wall could only creep one
  // tile at a time around the focused photo and never move freely again.
  await page.locator('[data-photo-id]').first().click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  // Zoom in so the wall exceeds the window; otherwise the bounds pin it and the
  // key press correctly does nothing.
  const stage = (await page.getByTestId('stage').boundingBox())!
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  for (let i = 0; i < 3; i += 1) await zoomWall(-400)
  await page.waitForTimeout(700)

  const world = page.locator('[data-testid="world"]')
  const transformOf = () => world.evaluate((el: HTMLElement) => el.style.transform)
  const before = await transformOf()

  // The photo is still focused, yet the arrow must pan rather than walk the
  // selection — that is the bug this covers.
  await page.keyboard.press('ArrowUp')
  await expect.poll(transformOf).not.toBe(before)

  // The viewer must not reopen while panning.
  await expect(viewer).toBeHidden()
})

test('alt+arrows move the focused photo', async () => {
  await useEnglish()
  // Reset first: the previous test leaves the wall zoomed far in, where the
  // culled tile set may hold nothing clickable.
  await page.getByRole('button', { name: 'Square' }).click()
  await page.getByRole('button', { name: 'Rows' }).click()
  await expect(page.locator('[data-photo-id]').first()).toBeVisible()

  await page.locator('[data-photo-id]').first().click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  const selected = (): Promise<string | null> =>
    page.locator('[data-photo-id].selected').first().getAttribute('data-photo-id')

  const first = await selected()
  expect(first).toBeTruthy()

  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(selected).not.toBe(first)

  await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(selected).toBe(first)

  await expect(viewer).toBeHidden()
})

test('zooming out does not jump back to the first photo', async () => {
  await useEnglish()
  // Reset to the fitted wall, then zoom in so it overflows the window on both
  // axes - the bounds otherwise pin a fitted wall and nothing can pan.
  await page.getByRole('button', { name: 'Square' }).click()
  await page.getByRole('button', { name: 'Rows' }).click()
  await expect(page.locator('[data-photo-id]').first()).toBeVisible()

  const world = page.locator('[data-testid="world"]')
  const stage = (await page.getByTestId('stage').boundingBox())!
  const bar = page.getByTestId('wall-scrollbar')

  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  for (let i = 0; i < 3; i += 1) await zoomWall(-400)
  await page.waitForTimeout(700)
  await expect(bar).toBeVisible()

  /**
   * How far down the wall the thumb sits, 0..1.
   *
   * Normalised by the thumb's travel rather than read from `top` directly: a
   * thumb that is 30% tall reaches `top: 70%` only at the very bottom, so the
   * raw offset understates the position badly.
   */
  const thumbProgress = async (): Promise<number> =>
    page.locator('.scrollbar-thumb').evaluate((el: HTMLElement) => {
      const top = parseFloat(el.style.top)
      const size = parseFloat(el.style.height)
      const travel = 100 - size
      return travel > 0 ? top / travel : 0
    })

  // Drag the thumb well down the track. This is what puts the view deep in the
  // library; key repeats were used before, but the per-press step is a fraction
  // of the viewport, so the number needed depended on the zoom level.
  const track = (await bar.boundingBox())!
  await page.mouse.move(track.x + track.width / 2, track.y + 4)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.7, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(400)

  const before = await thumbProgress()
  // Any clearly non-zero position is enough: the point is that zooming must not
  // reset it to the top, not that the drag reaches a particular depth. How far
  // the thumb can travel depends on the fixture's height versus the window.
  expect(before).toBeGreaterThan(0.1)


  // Zooming out re-lays the wall out at a wider width. That reflow used to look
  // like a brand-new wall to the fit logic, which snapped the view to the top -
  // experienced as being thrown back to the first photo.
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await zoomWall(300)
  await page.waitForTimeout(700)

  // Still deep in the library, not back at the top.
  expect(await thumbProgress()).toBeGreaterThan(before / 2)
})

test('navigates a tall wall with the scrollbar', async () => {
  await useEnglish()
  const world = page.locator('[data-testid="world"]')
  const bar = page.getByTestId('wall-scrollbar')
  await expect(bar).toBeVisible()

  const yOf = () =>
    world.evaluate((el: HTMLElement) => {
      const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform)
      return m ? Math.round(Number(m[2])) : 0
    })

  // Home / End are what a scrollbar offers beyond dragging; they must reach the
  // exact ends of the wall rather than an approximation of them.
  await bar.focus()
  await page.keyboard.press('Home')
  await expect.poll(yOf).toBe(0)

  // End must land on the bottom bound and stay there. Asserting "no further
  // movement is possible" is scale- and fixture-independent, whereas a
  // hard-coded pixel value would only ever describe one library.
  await page.keyboard.press('End')
  await page.waitForTimeout(300)
  const yEnd = await yOf()
  expect(yEnd).toBeLessThan(-100)

  await page.keyboard.press('End')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
  expect(await yOf()).toBe(yEnd)

  // The thumb stops with its bottom edge exactly at the end of the track - not
  // past it. Expressed as offset + size so it holds for any thumb height, where
  // a fixed `top` value would only fit one fixture size.
  const thumb = await page.locator('.scrollbar-thumb').evaluate((el: HTMLElement) => ({
    top: parseFloat(el.style.top),
    height: parseFloat(el.style.height)
  }))
  expect(thumb.top + thumb.height).toBeCloseTo(100, 0)
})

test('shows the destination date while dragging the scrollbar', async () => {
  await useEnglish()
  const bar = page.getByTestId('wall-scrollbar')
  const track = (await bar.boundingBox())!
  const label = page.locator('.scrollbar-label')

  // Drag from the top to the middle. The label must name a date rather than
  // staying blank, which is the whole point of the control for navigation.
  await page.mouse.move(track.x + track.width / 2, track.y + 4)
  await page.mouse.down()
  await page.mouse.move(track.x + track.width / 2, track.y + track.height * 0.6, { steps: 10 })

  await expect(label).toBeVisible()
  const text = (await label.textContent()) ?? ''
  // A localised date, e.g. 07/14/2019.
  expect(text).toMatch(/\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/)

  await page.mouse.up()
})

test('steps through photos with the arrows while the viewer is open', async () => {
  await useEnglish()
  // Reset the view: the previous test pans deep into the library, and a culled
  // wall has no tiles to click. Switching layout modes re-fits the view.
  await page.getByRole('button', { name: 'Square' }).click()
  await page.getByRole('button', { name: 'Rows' }).click()
  await expect(page.locator('[data-photo-id]').first()).toBeVisible()

  await page.locator('[data-photo-id]').first().click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()

  const firstCaption = await viewer.locator('.viewer-meta strong').textContent()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => viewer.locator('.viewer-meta strong').textContent()).not.toBe(firstCaption)

  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => viewer.locator('.viewer-meta strong').textContent()).toBe(firstCaption)

  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('keeps the viewer keyboard separate from the wall', async () => {
  await useEnglish()
  // The viewer uses the arrows to step between photos; the wall must not pan
  // underneath it.
  await page.locator('[data-photo-id]').first().click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()

  const world = page.locator('[data-testid="world"]')
  const before = await world.evaluate((el: HTMLElement) => el.style.transform)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')

  expect(await world.evaluate((el: HTMLElement) => el.style.transform)).toBe(before)
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('opens a photo in the viewer and navigates with the keyboard', async () => {
  await useEnglish()
  // A click, not a drag: the distance threshold must not swallow it.
  await page.locator('[data-photo-id]').first().click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()

  await page.keyboard.press('ArrowRight')
  await expect(viewer).toContainText('2020-01-05')

  await page.keyboard.press('ArrowLeft')
  await expect(viewer).toContainText('2024-03-11')

  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('zooms and pans inside the viewer', async () => {
  await useEnglish()
  // The large landscape fixture: a 200x300 photo can never overflow the stage,
  // so there would be nothing to pan.
  await openPhoto('Kyoto')
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()

  const stage = page.getByTestId('viewer-stage')
  const image = stage.locator('img.viewer-image:not(.preview)')
  await expect.poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)

  const transformOf = () => image.evaluate((img: HTMLElement) => img.style.transform)
  expect(await transformOf()).toBe('')

  // Wheel in: the image must actually scale up.
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await zoomWall(-400)
  await expect.poll(transformOf).toContain('scale(')

  // Drag: the image must move, and the viewer must NOT close (a pan is not a
  // click-to-dismiss).
  const before = await image.evaluate((img: HTMLElement) => img.style.transform)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 80, { steps: 8 })
  await page.mouse.up()

  expect(await image.evaluate((img: HTMLElement) => img.style.transform)).not.toBe(before)
  await expect(viewer).toBeVisible()

  // Fit restores the whole photo.
  await page.getByRole('button', { name: 'Fit' }).click()
  expect(await transformOf()).toBe('')

  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('rotates the photo a quarter turn at a time', async () => {
  await useEnglish()
  // A landscape photo on purpose: turning it upright is what forces a refit.
  await openPhoto('Kyoto')
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()

  const image = page.getByTestId('viewer-image')
  const transformOf = () => image.evaluate((img: HTMLElement) => img.style.transform)
  const boxOf = () =>
    image.evaluate((img: HTMLElement) => {
      const rect = img.getBoundingClientRect()
      return { width: Math.round(rect.width), height: Math.round(rect.height) }
    })

  expect(await transformOf()).toBe('')
  const upright = await boxOf()

  await page.getByRole('button', { name: 'Rotate right' }).click()
  await expect.poll(transformOf).toContain('rotate(90deg)')
  await expect(viewer).toContainText('90°')

  // A quarter turn really swaps the axes on screen. The photo already fills the
  // stage height when upright, so it stays that tall while getting much
  // narrower: the aspect ratio has to flip from landscape to portrait.
  await expect.poll(async () => {
    const turned = await boxOf()
    return turned.width < upright.width && turned.width < turned.height
  }).toBe(true)

  // ...and the rotated box must stay inside the stage: a landscape photo turned
  // upright overflows the height, so it is refitted rather than clipped.
  const stageBox = (await page.getByTestId('viewer-stage').boundingBox())!
  const turned = await boxOf()
  expect(turned.height).toBeLessThanOrEqual(Math.ceil(stageBox.height))
  expect(turned.width).toBeLessThanOrEqual(Math.ceil(stageBox.width))

  // Four quarter turns come back to upright.
  await page.getByRole('button', { name: 'Rotate right' }).click()
  await page.getByRole('button', { name: 'Rotate right' }).click()
  await page.getByRole('button', { name: 'Rotate right' }).click()
  expect(await transformOf()).toBe('')

  // And the keyboard reaches the same state from the other direction.
  await page.keyboard.press('[')
  await expect.poll(transformOf).toContain('rotate(-90deg)')

  await page.getByRole('button', { name: 'Fit' }).click()
  expect(await transformOf()).toBe('')

  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('pinches to zoom inside the viewer', async () => {
  await useEnglish()
  await openPhoto('Kyoto')
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()

  const image = page.getByTestId('viewer-image')
  await expect.poll(async () => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  const scaleOf = () =>
    image.evaluate((img: HTMLElement) => {
      const match = /scale\(([\d.]+)\)/.exec(img.style.transform)
      return match ? Number(match[1]) : 1
    })

  // Two synthetic pointers cannot be produced with the mouse API, so the
  // PointerEvents are dispatched directly on the stage. This still exercises the
  // real React handlers, the pinch maths and the resulting CSS transform.
  const stageBox = (await page.getByTestId('viewer-stage').boundingBox())!
  const cx = stageBox.x + stageBox.width / 2
  const cy = stageBox.y + stageBox.height / 2

  const dispatch = (type: string, pointerId: number, x: number, y: number): void => {
    page.evaluate(
      ({ type, pointerId, x, y }) => {
        const stage = document.querySelector('[data-testid="viewer-stage"]')!
        stage.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: 'touch',
            button: 0,
            clientX: x,
            clientY: y
          })
        )
      },
      { type, pointerId, x, y }
    )
  }

  expect(await scaleOf()).toBe(1)

  await dispatch('pointerdown', 11, cx - 50, cy)
  await dispatch('pointerdown', 12, cx + 50, cy)
  // Spread from 100px to 300px apart: a 3x pinch.
  await dispatch('pointermove', 12, cx + 250, cy)

  await expect.poll(scaleOf).toBeGreaterThan(1)
  await expect(viewer).toBeVisible()

  await dispatch('pointerup', 12, cx + 250, cy)
  await dispatch('pointerup', 11, cx - 50, cy)

  // Releasing the fingers must not dismiss the photo.
  await expect(viewer).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('does not open the viewer when the wall was dragged', async () => {
  await useEnglish()
  await page.mouse.move(600, 400)
  await page.mouse.down()
  await page.mouse.move(750, 500, { steps: 10 })
  await page.mouse.up()

  await expect(page.getByRole('dialog')).toBeHidden()
})

test('switches language at runtime', async () => {
  await useEnglish()

  await chooseLanguage('zh-CN')
  await expect(page.getByRole('button', { name: '筛选' })).toBeVisible()
  // `lang` drives hyphenation, CJK font fallback and screen-reader pronunciation.
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')

  await chooseLanguage('fr')
  await expect(page.getByRole('button', { name: 'Filtres' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr')

  await chooseLanguage('en')
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})

test('picks up a new photo without reopening the folder', async () => {
  await useEnglish()
  // The file watcher is the feature most likely to regress silently.
  await writeJpeg(photoDir, '2025-04-20 Nara.jpg', '2025:04:20 12:00:00')

  await expect(page.locator('.photo-count')).toHaveText('16/16')

  // Newest first, so the file that just appeared leads the wall.
  const captions = page.locator('.tile-caption')
  await expect(captions.nth(0)).toHaveText('2025-04-20')
})

test('keeps the EXIF panel open while stepping through photos', async () => {
  await useEnglish()
  await openLibrary()
  // Reported: opening the details panel and then pressing an arrow key closed
  // it, even though the panel had been opened deliberately. The choice is a
  // browsing preference, so it has to survive both the photo change and a
  // restart.
  await openPhoto('Kyoto')

  await page.keyboard.press('i')
  await expect(page.getByTestId('info-panel')).toBeVisible()

  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('info-panel')).toBeVisible()

  // And it is remembered: restart with the panel open and it comes back open.
  await page.waitForTimeout(500)
  await app.close()
  app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  await openLibrary()
  await openPhoto('Kyoto')
  await expect(page.getByTestId('info-panel')).toBeVisible()

  // Reset the preference before leaving. It is persisted, so leaving it on
  // would reopen the viewer with the panel expanded for every later test in
  // this file — the panel overlaps the toolbar, and an unrelated test then
  // failed clicking the gear menu.
  await page.keyboard.press('i')
  await expect(page.getByTestId('info-panel')).toBeHidden()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
})

test('persists the chosen layout and language across a restart', async () => {
  await useEnglish()
  await page.getByRole('button', { name: 'Square' }).click()
  await chooseLanguage('fr')

  // Give the debounced save a moment to land before restarting.
  await page.waitForTimeout(500)
  await app.close()

  app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  await expect(page.getByRole('button', { name: 'Carré' })).toHaveAttribute('aria-pressed', 'true')
  // The language now lives behind the gear, so the value is checked after
  // opening it; the button label is already French, which proves it was restored.
  await page.locator('.menu-trigger').click()
  await expect(page.locator('.settings-menu select')).toHaveValue('fr')
})

test('opens the About dialog from the gear menu', async () => {
  await useEnglish()
  await page.locator('.menu-trigger').click()
  await page.getByRole('button', { name: 'About PhotoStream' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // The version comes from `app.getVersion()` through the IPC bridge, so its
  // presence proves the whole path works, not just that the dialog rendered.
  await expect(dialog.getByText(/^Version \d+\.\d+\.\d+/)).toBeVisible()
  // Runtime versions are the part a bug report needs.
  await expect(dialog.locator('.about-facts')).toContainText('Chromium')
  await expect(dialog.getByText('Keyboard shortcuts')).toBeVisible()

  // Escape closes it, and the menu must not reappear behind it.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.menu-panel')).toHaveCount(0)
})

/**
 * Drag-and-drop, split into the two halves that can actually be driven here.
 *
 * A real drop cannot be reproduced in this harness: Chromium derives a `File`'s
 * path from an OS-level drag, and `webUtils.getPathForFile` returns `''` for any
 * `File` constructed in JavaScript. The path resolver also cannot be stubbed —
 * `contextBridge` exposes a frozen object, so assigning to
 * `window.photoStream.pathForFile` silently does nothing (verified: the object
 * is frozen and the assignment is discarded).
 *
 * So this covers what is genuinely observable end-to-end:
 * - the overlay reacts to real DOM drag events, and
 * - the IPC entry point opens a real directory on disk.
 *
 * The drop → path → open wiring between them is covered by
 * `useFileDrop.test.tsx`, which can supply a path resolver directly.
 */
test('shows the drop hint only while files are being dragged', async () => {
  await useEnglish()
  const overlay = page.getByTestId('drop-overlay')
  await expect(overlay).toHaveCount(0)

  await page.evaluate(() => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true, cancelable: true }))
  })
  await expect(overlay).toBeVisible()

  // Leaving the window must take the hint away again, or it would sit over the
  // wall forever.
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))
    window.dispatchEvent(new DragEvent('dragleave', { dataTransfer, bubbles: true, cancelable: true }))
  })
  await expect(overlay).toHaveCount(0)

  // Dragging text is not a file drop and must not advertise one.
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('text/plain', 'hello')
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true, cancelable: true }))
  })
  await expect(overlay).toHaveCount(0)
})

test('opens a dropped path through the main process', async () => {
  await useEnglish()

  // A second library, so the assertion is about the drop path rather than about
  // re-opening what is already loaded.
  const droppedDir = await mkdtemp(join(tmpdir(), 'photostream-e2e-dropped-'))
  await writeJpeg(droppedDir, '2026-05-01 Dropped.jpg', '2026:05:01 09:00:00')
  await writeJpeg(droppedDir, '2026-05-02 Dropped Too.jpg', '2026:05:02 09:00:00')

  // The bridge method the drop handler calls, with the main process resolving
  // the path for real (`resolveDropTarget`): it scans the folder and starts
  // watching it. The returned shape proves the folder was actually opened.
  const result = await page.evaluate((dir) => window.photoStream.openDropped(dir), droppedDir)
  expect(result.dir).toBe(droppedDir)
  expect(result.photos).toHaveLength(2)
  expect(result.skipped).toBe(0)

  // A non-JPEG target is rejected by the main process rather than silently
  // opening the wrong folder.
  const notAPhoto = join(droppedDir, 'notes.txt')
  await writeFile(notAPhoto, 'x', 'utf-8')
  await expect(
    page.evaluate((path) => window.photoStream.openDropped(path), notAPhoto)
  ).rejects.toThrow(/not a folder of JPEG photos/)

  await rm(droppedDir, { recursive: true, force: true })

  // Leave the suite on the original library for any test added later.
  await openLibrary()
})

test('reopens a folder from the history menu', async () => {
  await useEnglish()

  // Build a second library through the real UI path, so the history is recorded
  // by `useWall` rather than injected: the folder picker is stubbed only at the
  // native-dialog boundary.
  const secondDir = await mkdtemp(join(tmpdir(), 'photostream-e2e-second-'))
  await writeJpeg(secondDir, '2026-01-01 Second.jpg', '2026:01:01 09:00:00')

  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, secondDir)
  await page.getByRole('button', { name: 'Open folder…' }).click()
  await expect(page.locator('.photo-count')).toHaveText('1/1')
  await expect(page.locator('.dir-label')).toHaveText(secondDir)

  const trigger = page.getByRole('button', { name: 'Recent folders' })
  await expect(trigger).toBeVisible()
  await openHistoryPanel()

  const items = page.locator('.history-item')
  await expect(items.first()).toBeVisible()
  expect(await items.count()).toBeGreaterThan(1)

  // The folder currently open is marked rather than omitted, so it is visible
  // in context without being re-openable by accident.
  await expect(items.first()).toHaveClass(/current/)

  // Open the previous library, which is the second entry.
  const target = items.nth(1)
  const expectedPath = (await target.locator('.history-path').textContent()) ?? ''
  expect(expectedPath).toBe(photoDir)
  await target.locator('.history-open').click()

  await expect(page.locator('.menu-panel')).toHaveCount(0)
  await expect(page.locator('.dir-label')).toHaveText(expectedPath)
  // Whatever was opened must become the newest entry, i.e. move to the top.
  await openHistoryPanel()
  await expect(page.locator('.history-item').first()).toHaveClass(/current/)
  await page.keyboard.press('Escape')

  await rm(secondDir, { recursive: true, force: true })
})

/**
 * Open the recent-folders panel, tolerating it already being open.
 *
 * The trigger toggles, so a blind click after a test that left the panel open
 * would close it and the next lookup would time out. Checking for the panel
 * first makes every call site independent of the previous test.
 */
async function openHistoryPanel(): Promise<void> {
  if ((await page.locator('.history-panel').count()) === 0) {
    await page.getByRole('button', { name: 'Recent folders' }).click()
  }
  await expect(page.locator('.history-panel')).toBeVisible()
}

test('forgets one folder and clears them all', async () => {
  await useEnglish()

  // Make sure there are at least three entries, so removing one and then the
  // current one still leaves something for "Clear all" to act on. Earlier tests
  // leave an unpredictable number behind.
  for (const filler of ['alpha', 'beta']) {
    const dir = await mkdtemp(join(tmpdir(), `photostream-e2e-${filler}-`))
    await writeJpeg(dir, `${filler}.jpg`, '2026:02:01 09:00:00')
    await app.evaluate(async ({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
    }, dir)
    await page.getByRole('button', { name: 'Open folder…' }).click()
    await expect(page.locator('.dir-label')).toHaveText(dir)
    await rm(dir, { recursive: true, force: true })
  }

  await openHistoryPanel()
  const before = await page.locator('.history-item').count()
  expect(before).toBeGreaterThan(2)

  // Remove the last entry; the list shrinks by exactly one and the panel stays
  // open so several folders can be forgotten in a row.
  const lastName = (await page.locator('.history-item .history-name').last().textContent()) ?? ''
  await page.locator('.history-item .history-remove').last().click()
  await expect(page.locator('.history-item')).toHaveCount(before - 1)
  await expect(page.locator('.history-item .history-name').last()).not.toHaveText(lastName)

  // Removing the folder that is currently open must not close the wall.
  const currentName = (await page.locator('.history-item.current .history-name').textContent()) ?? ''
  await page.locator('.history-item.current .history-remove').click()
  await expect(page.locator('.photo-count')).not.toHaveText('0/0')
  await expect(page.locator('.history-item.current')).toHaveCount(0)
  expect(currentName).not.toBe('')

  // Clear all empties the list, which removes the trigger entirely rather than
  // leaving a dropdown with nothing in it.
  await page.getByRole('button', { name: 'Clear all' }).click()
  await expect(page.locator('.history-item')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Recent folders' })).toHaveCount(0)
})

test('keeps the history across a restart', async () => {
  await useEnglish()
  // The previous test cleared the list, so build one entry back up.
  await openLibrary()

  await page.waitForTimeout(500)
  await app.close()

  app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  const trigger = page.getByRole('button', { name: 'Recent folders' })
  await expect(trigger).toBeVisible()
  await trigger.click()
  // `openLibrary` re-scanned the folder after the restart, so it is both the
  // restored `lastDir` and the newest history entry.
  await expect(page.locator('.history-item').first()).toHaveClass(/current/)
  await expect(page.locator('.history-item .history-path').first()).toHaveText(photoDir)
  await page.keyboard.press('Escape')
})
