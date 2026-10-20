#!/usr/bin/env node
/**
 * The benchmark suite.
 *
 * `npm run bench` runs the headless cases — scan, metadata, cache, layout,
 * thumbnails — and compares them with `benchmarks/baseline.json`. `npm run
 * bench:all` adds the 40 000-photo cases and the Electron-level ones (startup,
 * click-to-first-tile), which is the run worth doing before a release.
 *
 * The rules the report applies are in `report.ts`: a relative regression against
 * the recorded baseline, and an absolute budget per case. Budgets are what make
 * the suite useful on someone else's machine; the baseline is what makes it
 * useful on yours.
 *
 * Usage:
 *   node --import tsx scripts/bench/index.ts [options]
 *
 *   --large               include the 40 000-photo cases (about 3.6 GB of fixtures)
 *   --app                 also run the Electron cases (needs `npm run build`)
 *   --update              record this run as the new baseline
 *   --only=<id,id>        run cases whose id contains one of these
 *   --samples=<n>         override the sample count of every case
 *   --runs=<n>            launches per app metric (default 3)
 *   --fixture-root=<dir>  where the synthetic libraries live
 *   --baseline=<file>     compare against a different baseline
 *   --json                print the raw results instead of the table
 *   --clean               delete the fixtures before running
 *   --list                list the cases and exit
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFixtures, ensureLargeLibrary, type BenchFixtures } from './fixtures'
import { headlessCases, prepareScratch, runCases, type CaseResult } from './cases'
import {
  BASELINE_VERSION,
  compare,
  describeMachine,
  loadBaseline,
  renderTable,
  saveBaseline,
  summarise,
  type Baseline
} from './report'

interface Options {
  app: boolean
  update: boolean
  only: string[]
  large: boolean
  samples?: number
  fixtureRoot?: string
  baselinePath?: string
  json: boolean
  clean: boolean
  list: boolean
  runs: number
}

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    app: false,
    update: false,
    only: [],
    large: false,
    json: false,
    clean: false,
    list: false,
    runs: 3
  }
  for (const argument of argv) {
    if (argument === '--app') options.app = true
    else if (argument === '--update') options.update = true
    else if (argument === '--large') options.large = true
    else if (argument === '--json') options.json = true
    else if (argument === '--clean') options.clean = true
    else if (argument === '--list') options.list = true
    else if (argument.startsWith('--only=')) {
      options.only = argument.slice(7).split(',').filter(Boolean)
    } else if (argument.startsWith('--samples=')) {
      options.samples = Number(argument.slice(10))
    } else if (argument.startsWith('--runs=')) {
      options.runs = Number(argument.slice(7))
    } else if (argument.startsWith('--fixture-root=')) {
      options.fixtureRoot = argument.slice(15)
    } else if (argument.startsWith('--baseline=')) {
      options.baselinePath = argument.slice(11)
    } else if (argument === '--help' || argument === '-h') {
      console.log('see the comment at the top of scripts/bench/index.ts')
      process.exit(0)
    } else {
      console.error(`unknown option ${argument}`)
      process.exit(2)
    }
  }
  return options
}

function selectCases<T extends { id: string; requires?: string }>(
  definitions: readonly T[],
  options: Options
): T[] {
  return definitions.filter((definition) => {
    if (!options.large && definition.requires === 'large') return false
    if (options.only.length === 0) return true
    // Prefix or whole segment, so `--only=app` does not also match
    // `filters.apply`: a plain substring would.
    return options.only.some(
      (pattern) => definition.id.startsWith(pattern) || definition.id.includes(`.${pattern}`)
    )
  })
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const fixtureRoot = options.fixtureRoot ?? join(tmpdir(), 'photostream-bench')
  const baselinePath = options.baselinePath ?? join(repo, 'benchmarks', 'baseline.json')
  const lastPath = join(repo, 'benchmarks', 'last.json')

  const progress = (message: string): void => {
    if (!options.json) process.stderr.write(`${message}\n`)
  }

  if (options.clean) await rm(fixtureRoot, { recursive: true, force: true })

  progress(`fixtures   ${fixtureRoot}`)
  let fixtures: BenchFixtures
  try {
    fixtures = await ensureFixtures(fixtureRoot)
  } catch (error) {
    console.error(`could not build the fixtures: ${String(error)}`)
    process.exitCode = 1
    return
  }

  const definitions = selectCases(headlessCases(fixtures), options)

  if (options.list) {
    for (const definition of definitions) {
      console.log(`${definition.id.padEnd(30)} ${definition.title}`)
    }
    return
  }

  // The 40 000-photo tree is only built when a case needs it: it is 3.6 GB of
  // files, and most runs are about one changed area.
  let large = fixtures.lib40000
  let rebuiltLarge = false
  if (definitions.some((definition) => definition.requires === 'large')) {
    progress('building   40 000-photo library (once per fixture version)')
    const built = await ensureLargeLibrary(fixtures)
    large = built.dir
    rebuiltLarge = built.built
  }
  if (fixtures.rebuilt || rebuiltLarge) {
    progress(
      'note      fixtures were (re)built: the first pass is slower because the virus scanner has not seen these files yet'
    )
    progress('          record the baseline on a second run, not this one')
  }

  const scratch = await mkdtemp(join(fixtureRoot, 'scratch-'))
  await prepareScratch(scratch)

  const results: CaseResult[] = []
  try {
    progress('')
    results.push(
      ...(await runCases(
        definitions,
        { fixtures, scratch, large },
        {
          samples: options.samples,
          onResult: (value) =>
            progress(
              `  ${value.id.padEnd(28)} ${value.median.toFixed(2).padStart(9)} ${value.unit}   (n=${value.samples})`
            )
        }
      ))
    )

    if (options.app) {
      progress('')
      const { runAppCases } = await import('./app')
      results.push(
        ...(await runAppCases({
          library: fixtures.lib4000,
          entry: join(repo, 'out', 'main', 'index.js'),
          runs: options.runs,
          only: options.only,
          onProgress: progress
        }))
      )
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  const baseline = await loadBaseline(baselinePath)
  const rows = compare(results, baseline)
  const machine = describeMachine()
  const capturedAt = new Date().toISOString().slice(0, 10)
  /**
   * The results of this run.
   *
   * `cases` is merged with what the file already holds rather than replacing it,
   * so a targeted run (`--only=parse`, or a headless run without `--app`) updates
   * the cases it measured and leaves the rest of the baseline alone. Replacing
   * would quietly drop the 40 000-photo and Electron cases from the record.
   */
  const record = (previous: Baseline | null): Baseline => ({
    version: BASELINE_VERSION,
    capturedAt,
    machine: machine.machine,
    platform: machine.platform,
    node: machine.node,
    samples: options.samples ?? 0,
    cases: {
      ...(previous?.cases ?? {}),
      ...Object.fromEntries(
        results.map((result) => [
          result.id,
          {
            median: Number(result.median.toFixed(3)),
            min: Number(result.min.toFixed(3)),
            unit: result.unit
          }
        ])
      )
    }
  })

  await mkdir(dirname(lastPath), { recursive: true })
  await saveBaseline(lastPath, record(await loadBaseline(lastPath)))
  if (options.update) {
    await saveBaseline(baselinePath, record(baseline))
    progress(`baseline   updated ${baselinePath}`)
  }

  const summary = summarise(rows)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          machine,
          results,
          rows: rows.map((row) => ({
            id: row.result.id,
            status: row.status,
            deltaPct: row.deltaPct ?? null
          }))
        },
        null,
        2
      )
    )
  } else {
    console.log('')
    console.log(
      `PhotoStream benchmarks - ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    )
    console.log(`machine   ${machine.platform} | ${machine.machine} | node ${machine.node}`)
    console.log(
      `baseline  ${baseline ? `${baseline.capturedAt} | ${baseline.machine}` : 'none (--update records one)'}`
    )
    if (baseline && baseline.machine !== machine.machine) {
      console.log(
        '          recorded on different hardware: read the delta column as a hint, budgets as the check'
      )
    }
    console.log('')
    console.log(renderTable(rows, baseline))
    console.log('')
    const parts = [`${summary.total} cases`]
    if (summary.over > 0) parts.push(`${summary.over} over budget`)
    if (summary.slow > 0) parts.push(`${summary.slow} slower than baseline`)
    if (summary.faster > 0) parts.push(`${summary.faster} faster`)
    if (summary.fresh > 0) parts.push(`${summary.fresh} new`)
    console.log(parts.join(' | '))
    if (summary.failed) {
      console.log('')
      console.log(
        'a case is over budget or slower than the baseline; if the change is intended, re-record with --update'
      )
    } else {
      console.log(`results written to ${lastPath}`)
    }
  }

  if (summary.failed) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
