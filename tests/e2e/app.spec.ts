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
  await page.locator('.menu-trigger').click()
  const picker = page.locator('.settings-menu select')
  const current = await picker.inputValue()
  // Escape rather than select when nothing needs changing, so the state is left
  // exactly as it was.
  if (current !== 'en') await picker.selectOption('en')
  else await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()
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

/** Open the seeded photo folder through the stubbed native dialog. */
async function openLibrary(): Promise<void> {
  await app.evaluate(async ({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, photoDir)

  await useEnglish()

  // Both the toolbar and the empty state offer the action; the empty-state one
  // is the visible primary call to action at this point.
  await page.locator('.empty-state button.primary').click()
  await expect(page.locator('[data-photo-id]')).toHaveCount(3)
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
})

test('reorders the wall when the sort mode changes', async () => {
  await useEnglish()
  const captions = page.locator('.tile-caption')
  const picker = page.getByLabel('Sort order')

  await expect(picker).toHaveValue('taken-desc')
  await expect(captions.nth(0)).toHaveText('2024-03-11')

  await picker.selectOption('taken-asc')
  await expect(captions.nth(0)).toHaveText('2019-07-14')
  await expect(captions.nth(2)).toHaveText('2024-03-11')

  // Name order ignores the capture date entirely.
  await picker.selectOption('name-asc')
  await expect(captions.nth(0)).toHaveText('2019-07-14')
  await picker.selectOption('name-desc')
  await expect(captions.nth(0)).toHaveText('2024-03-11')

  // Back to the default so later tests see the documented order.
  await picker.selectOption('taken-desc')
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
    await expect(page.locator('[data-photo-id]')).toHaveCount(3)
  }
})

test('filters by file name and resets', async () => {
  await useEnglish()
  await page.getByRole('button', { name: 'Filters' }).click()

  await page.getByLabel('File name').fill('Kyoto')
  await expect(page.locator('[data-photo-id]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page.locator('[data-photo-id]')).toHaveCount(3)

  await page.getByRole('button', { name: 'Filters' }).click()
})

test('filters by capture date range', async () => {
  await useEnglish()
  await page.getByRole('button', { name: 'Filters' }).click()

  await page.getByLabel('Date from').fill('2020-01-01')
  await expect(page.locator('[data-photo-id]')).toHaveCount(2)

  await page.getByLabel('Date to').fill('2024-01-01')
  await expect(page.locator('[data-photo-id]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Reset' }).click()
  await page.getByRole('button', { name: 'Filters' }).click()
})

test('zooms with the wheel and pans by dragging', async () => {
  await useEnglish()
  const world = page.locator('[data-testid="world"]')
  const before = await world.evaluate((el: HTMLElement) => el.style.transform)

  await page.mouse.move(600, 400)
  await page.mouse.wheel(0, -400)
  await expect.poll(async () => world.evaluate((el: HTMLElement) => el.style.transform)).not.toBe(before)

  const afterZoom = await world.evaluate((el: HTMLElement) => el.style.transform)
  await page.mouse.move(600, 400)
  await page.mouse.down()
  await page.mouse.move(700, 480, { steps: 8 })
  await page.mouse.up()

  const afterDrag = await world.evaluate((el: HTMLElement) => el.style.transform)
  expect(afterDrag).not.toBe(afterZoom)
})

test('pans the wall with the arrow keys', async () => {
  await useEnglish()
  const world = page.locator('[data-testid="world"]')
  const transformOf = () => world.evaluate((el: HTMLElement) => el.style.transform)

  // Start from a known position: the folder was just zoomed and dragged.
  await page.getByRole('button', { name: 'Rows' }).click()
  const before = await transformOf()

  // The right arrow reveals what is to the right, so the wall moves left.
  await page.keyboard.press('ArrowRight')
  await expect.poll(transformOf).not.toBe(before)
  const afterRight = await transformOf()

  await page.keyboard.press('ArrowLeft')
  // Back where it started, within the rounding of the step.
  expect(await transformOf()).not.toBe(afterRight)

  await page.keyboard.press('ArrowDown')
  const afterDown = await transformOf()
  expect(afterDown).not.toBe(afterRight)

  // Shift takes a much larger step.
  await page.keyboard.press('Shift+ArrowDown')
  expect(await transformOf()).not.toBe(afterDown)
})

test('arrow keys pan the wall even after a photo has been viewed', async () => {
  await useEnglish()

  // Reset to a fitted wall: earlier tests leave it zoomed and panned far enough
  // that the culled set can be empty. Switching layouts changes the fit key.
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

  const world = page.locator('[data-testid="world"]')
  const transformOf = () => world.evaluate((el: HTMLElement) => el.style.transform)
  const before = await transformOf()

  await page.keyboard.press('ArrowRight')
  await expect.poll(transformOf).not.toBe(before)

  // The viewer must not reopen while panning.
  await expect(viewer).toBeHidden()
})

test('alt+arrows move the focused photo', async () => {
  await useEnglish()
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
  const world = page.locator('[data-testid="world"]')

  // Pan well away from the start.
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowDown')
  await page.waitForTimeout(400)

  const yBefore = await world.evaluate((el: HTMLElement) => {
    const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform)
    return m ? Number(m[2]) : 0
  })
  expect(yBefore).toBeLessThan(-500)

  // Zooming out re-lays the wall out at a wider width. That reflow used to look
  // like a brand-new wall to the fit logic, which snapped the view to the top —
  // experienced as being thrown back to the first photo.
  const stage = (await page.getByTestId('stage').boundingBox())!
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2)
  await page.mouse.wheel(0, 300)
  await page.waitForTimeout(700)

  const yAfter = await world.evaluate((el: HTMLElement) => {
    const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform)
    return m ? Number(m[2]) : 0
  })

  // Still deep in the library, not back at the top.
  expect(yAfter).toBeLessThan(-500)
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
  await page.mouse.wheel(0, -400)
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

  await expect(page.locator('[data-photo-id]')).toHaveCount(4)

  // Newest first, so the file that just appeared leads the wall.
  const captions = page.locator('.tile-caption')
  await expect(captions.nth(0)).toHaveText('2025-04-20')
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
