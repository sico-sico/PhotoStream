/**
 * Benchmark cases that need a real Electron process.
 *
 * Everything here is a number a user would recognise: how long until the window
 * is up, how long until a folder's photos are on screen, how long a reopen takes.
 * They need a built `out/` and a few seconds each, so they are opt-in (`--app`)
 * and the CI-friendly headless suite stays in `cases.ts`.
 *
 * The measurement mirrors what a person does — the folder picker is stubbed at
 * the Electron level rather than bypassed in the renderer — so a regression here
 * means the real path got slower, not a helper that only the benchmark calls.
 */
import { _electron as electron } from 'playwright'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { CaseResult } from './cases'

export interface AppBenchOptions {
  /** Photo library the app opens; the 4 000-photo fixture. */
  library: string
  /** Path to the built main entry point. */
  entry: string
  /** Samples per metric. */
  runs?: number
  /** Case-id filters, matching the headless suite's `--only`. */
  only?: string[]
  onProgress?: (message: string) => void
}

interface Sample {
  window: number
  dom: number
  firstTile: number | null
  firstImage: number | null
  rssMb: number
}

function settings(lastDir: string): string {
  return JSON.stringify({
    lastDir,
    layout: 'grid',
    sort: 'taken-desc',
    filters: { from: '', to: '', text: '' },
    locale: 'en',
    history: [],
    recursive: true,
    viewerInfo: false,
    ringSize: 70,
    cacheBudgetMb: 0
  })
}

async function writeSettings(userDataDir: string, lastDir: string): Promise<void> {
  const dataDir = join(userDataDir, 'PhotoStreamData')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'settings.json'), settings(lastDir), 'utf8')
}

/**
 * Launch the app and wait for whatever this sample is about.
 *
 * `picker` stubs the OS dialog and clicks the empty state's button, which is the
 * only part of a user-initiated open that cannot be driven from a test: it keeps
 * the renderer → IPC → scan → protocol path intact.
 */
async function launch(
  entry: string,
  userDataDir: string,
  options: { expectPhotos: boolean; picker?: string }
): Promise<Sample & { errors: string[] }> {
  const started = performance.now()
  const app = await electron.launch({
    args: [entry],
    env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir }
  })
  try {
    const page = await app.firstWindow()
    const windowAt = performance.now()
    await page.waitForLoadState('domcontentloaded')
    const domAt = performance.now()

    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))

    if (options.picker) {
      await page.waitForSelector('.empty-state button.primary', {
        state: 'attached',
        timeout: 120_000
      })
      await app.evaluate(async ({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
      }, options.picker)
      await page.locator('.empty-state button.primary').click({ force: true })
    }

    let firstTile: number | null = null
    let firstImage: number | null = null
    if (options.expectPhotos) {
      await page.waitForSelector('[data-photo-id]', { timeout: 300_000 })
      firstTile = performance.now()
      await page.waitForFunction(
        () => {
          const image = document.querySelector<HTMLImageElement>('[data-photo-id] img')
          return Boolean(image && image.complete && image.naturalWidth > 0)
        },
        undefined,
        { timeout: 300_000 }
      )
      firstImage = performance.now()
    }

    const main = await app.evaluate(() => process.memoryUsage().rss)
    return {
      window: Math.round(windowAt - started),
      dom: Math.round(domAt - started),
      firstTile: firstTile === null ? null : Math.round(firstTile - started),
      firstImage: firstImage === null ? null : Math.round(firstImage - started),
      rssMb: Math.round(main / 1024 / 1024),
      errors
    }
  } finally {
    await app.close()
  }
}

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function result(
  id: string,
  title: string,
  unit: CaseResult['unit'],
  values: readonly number[],
  budget?: number
): CaseResult {
  return {
    id,
    title,
    unit,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    samples: values.length,
    budget
  }
}

async function series(
  count: number,
  prepare: (index: number) => Promise<void>,
  sample: () => Promise<Sample & { errors: string[] }>,
  context: { onProgress?: (message: string) => void; label: string }
): Promise<Array<Sample & { errors: string[] }>> {
  const samples: Array<Sample & { errors: string[] }> = []
  for (let index = 0; index < count; index++) {
    await prepare(index)
    const measured = await sample()
    // A case that is fast because the wall never rendered is not a
    // measurement; fail loudly instead of recording a flattering number.
    if (measured.errors.length > 0) {
      throw new Error(`${context.label}: renderer error — ${measured.errors[0]}`)
    }
    samples.push(measured)
    context.onProgress?.(`  ${context.label} ${index + 1}/${count}`)
  }
  return samples
}

/**
 * Run the app-level cases.
 *
 * Order matters and is deliberate: the restore case is what fills the metadata
 * and thumbnail caches, and the warm open that follows relies on them. The cold
 * open gets its own data directory so wiping it cannot disturb the others.
 */
export async function runAppCases(options: AppBenchOptions): Promise<CaseResult[]> {
  try {
    await access(options.entry)
  } catch {
    throw new Error(`missing ${options.entry}: run \`npm run build\` before the app benchmarks`)
  }

  const runs = options.runs ?? 3
  const only = options.only ?? []
  const matches = (id: string): boolean =>
    only.length === 0 ||
    only.some((pattern) => id.startsWith(pattern) || id.includes(`.${pattern}`))
  const results: CaseResult[] = []
  const report = (value: CaseResult): void => {
    results.push(value)
    options.onProgress?.(`${value.id} ${value.median.toFixed(1)} ${value.unit}`)
  }

  // ---- Startup with no library -------------------------------------------
  if (matches('app.startup.empty')) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ps-bench-empty-'))
    try {
      const samples = await series(
        runs,
        () => writeSettings(userDataDir, ''),
        () => launch(options.entry, userDataDir, { expectPhotos: false }),
        { onProgress: options.onProgress, label: 'startup.empty' }
      )
      report(
        result('app.startup.empty.window', 'startup → window', 'ms', samples.map((s) => s.window), 900)
      )
      report(
        result('app.startup.empty.dom', 'startup → DOMContentLoaded', 'ms', samples.map((s) => s.dom), 1200)
      )
      report(result('app.startup.empty.rss', 'main process RSS', 'MB', samples.map((s) => s.rssMb)))
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }

  // ---- Restart with the last folder, caches warm --------------------------
  if (matches('app.startup.restore') || matches('app.open.warm')) {
    const warmUserData = await mkdtemp(join(tmpdir(), 'ps-bench-warm-'))
    try {
      // Discarded: the first launch is the one that fills the caches.
      await writeSettings(warmUserData, options.library)
      await launch(options.entry, warmUserData, { expectPhotos: true })

      if (matches('app.startup.restore')) {
        const samples = await series(
          runs,
          () => writeSettings(warmUserData, options.library),
          () => launch(options.entry, warmUserData, { expectPhotos: true }),
          { onProgress: options.onProgress, label: 'startup.restore' }
        )
        report(
          result(
            'app.startup.restore.firstTile',
            'restore → first tile',
            'ms',
            samples.map((s) => s.firstTile ?? 0),
            1800
          )
        )
        report(
          result(
            'app.startup.restore.firstImage',
            'restore → first image decoded',
            'ms',
            samples.map((s) => s.firstImage ?? 0),
            2200
          )
        )
      }

      // ---- Opening a known folder from the empty state --------------------
      if (matches('app.open.warm')) {
        const warm = await series(
          runs,
          () => writeSettings(warmUserData, ''),
          () => launch(options.entry, warmUserData, { expectPhotos: true, picker: options.library }),
          { onProgress: options.onProgress, label: 'open.warm' }
        )
        report(
          result(
            'app.open.warm.firstTile',
            'click → first tile, cache hit',
            'ms',
            warm.map((s) => s.firstTile ?? 0),
            1500
          )
        )
      }
    } finally {
      await rm(warmUserData, { recursive: true, force: true })
    }
  }

  // ---- Opening a folder for the first time --------------------------------
  if (matches('app.open.cold')) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ps-bench-cold-'))
    try {
      const samples = await series(
        Math.max(2, Math.min(runs, 3)),
        async () => {
          // Deleting the whole data directory is what makes this cold: metadata
          // cache, thumbnail cache and settings all go. The settings are written
          // back because `recursive` is one of them, and without it the fixture
          // (four album folders) has no photos at this level at all.
          await rm(join(userDataDir, 'PhotoStreamData'), { recursive: true, force: true })
          await writeSettings(userDataDir, '')
        },
        () => launch(options.entry, userDataDir, { expectPhotos: true, picker: options.library }),
        { onProgress: options.onProgress, label: 'open.cold' }
      )
      report(
        result('app.open.cold.firstTile', 'click → first tile, empty caches', 'ms', samples.map((s) => s.firstTile ?? 0), 6000)
      )
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }

  return results
}
