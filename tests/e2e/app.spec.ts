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

  await writeJpeg(photoDir, '2019-07-14 Kyoto.jpg', '2019:07:14 08:15:00')
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
async function useEnglish(): Promise<void> {
  // Located by class because the accessible name is translated with the rest
  // of the UI, which would make a role-based locator fail after a switch.
  const picker = page.locator('.language-picker select')
  if ((await picker.inputValue()) !== 'en') await picker.selectOption('en')
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()
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

  // Order comes from EXIF capture dates, oldest first — not from file names.
  const captions = page.locator('.tile-caption')
  await expect(captions.nth(0)).toHaveText('2019-07-14')
  await expect(captions.nth(1)).toHaveText('2020-01-05')
  await expect(captions.nth(2)).toHaveText('2024-03-11')
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

test('opens a photo in the viewer and navigates with the keyboard', async () => {
  await useEnglish()
  // A click, not a drag: the distance threshold must not swallow it.
  await page.locator('[data-photo-id]').first().click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toBeVisible()

  await page.keyboard.press('ArrowRight')
  await expect(viewer).toContainText('2020-01-05')

  await page.keyboard.press('ArrowLeft')
  await expect(viewer).toContainText('2019-07-14')

  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
})

test('zooms and pans inside the viewer', async () => {
  await useEnglish()
  await page.locator('[data-photo-id]').first().click()
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

  // The accessible name is itself translated, so the picker is located by its
  // stable class rather than by a label that changes with the language.
  const picker = page.locator('.language-picker select')
  await picker.selectOption('zh-CN')

  await expect(page.getByRole('button', { name: '筛选' })).toBeVisible()
  // `lang` drives hyphenation, CJK font fallback and screen-reader pronunciation.
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')

  await picker.selectOption('fr')
  await expect(page.getByRole('button', { name: 'Filtres' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr')

  await picker.selectOption('en')
  await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})

test('picks up a new photo without reopening the folder', async () => {
  await useEnglish()
  // The file watcher is the feature most likely to regress silently.
  await writeJpeg(photoDir, '2025-04-20 Nara.jpg', '2025:04:20 12:00:00')

  await expect(page.locator('[data-photo-id]')).toHaveCount(4)

  const captions = page.locator('.tile-caption')
  await expect(captions.nth(3)).toHaveText('2025-04-20')
})

test('persists the chosen layout and language across a restart', async () => {
  await page.getByRole('button', { name: 'Square' }).click()
  await page.getByRole('combobox', { name: /language/i }).selectOption('fr')

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
  await expect(page.getByRole('combobox', { name: /langue/i })).toHaveValue('fr')
})
