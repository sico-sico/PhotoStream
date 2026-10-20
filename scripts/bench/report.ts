/**
 * Recording results, comparing them with a baseline, and printing the table.
 *
 * Two different questions are being answered, and they need different rules:
 *
 *   budget   — "is this still in a range a user would accept?" An absolute
 *              ceiling per case, checked on every machine, because it is what
 *              actually matters and it does not depend on where the baseline was
 *              taken.
 *   baseline — "did this change make it worse?" A ratio against the last
 *              recorded run. Only meaningful on the same machine and the same
 *              fixture, so a run from a different machine says so and the ratio
 *              is printed as information rather than a verdict.
 */
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import type { CaseResult, Unit } from './cases'

export interface BaselineCase {
  median: number
  /**
   * Fastest sample.
   *
   * Recorded because a verdict built on the median alone is too easy to move:
   * one unlucky sample out of five shifts it by 20%, and a microbenchmark then
   * "regresses" without any code change. A regression has to show up in the best
   * run too, which is what `min` is.
   */
  min: number
  unit: Unit
}

export interface Baseline {
  version: 1
  capturedAt: string
  /** Enough of the machine to know whether a comparison is meaningful. */
  machine: string
  platform: string
  node: string
  /** Samples per case, so a baseline of 3 and a run of 7 are not confused. */
  samples: number
  cases: Record<string, BaselineCase>
}

export type Status = 'ok' | 'faster' | 'slow' | 'over' | 'new'

export interface Row {
  result: CaseResult
  baseline?: number
  deltaPct?: number
  status: Status
}

export const BASELINE_VERSION = 1

export async function loadBaseline(path: string): Promise<Baseline | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Baseline
    if (parsed.version !== BASELINE_VERSION) {
      console.warn(`baseline version ${parsed.version} is not ${BASELINE_VERSION}; ignoring it`)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function saveBaseline(path: string, baseline: Baseline): Promise<void> {
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
}

/**
 * What a result is comparable to.
 *
 * Wall-clock numbers mean nothing across machines, so the baseline records this
 * and the report prints it next to the run's own: a comparison whose machine
 * differs is worth reading, not worth failing a build over.
 */
export interface MachineFacts {
  platform: string
  machine: string
  node: string
}

export function describeMachine(): MachineFacts {
  const cpus = os.cpus()
  return {
    platform: `${process.platform} ${process.arch}`,
    machine: `${cpus[0]?.model?.trim() ?? 'unknown cpu'} · ${cpus.length} threads · ${Math.round(os.totalmem() / 1024 ** 3)} GB`,
    node: process.version
  }
}

/**
 * Compare a run with a baseline.
 *
 * Two guards against false alarms, both learned by running this on an idle
 * machine and watching it cry wolf:
 *
 * - A change only counts if it exceeds `tolerance` on the *median* and on the
 *   *fastest* sample. A background process slows a few samples; a real
 *   regression slows all of them, including the best.
 * - Changes smaller than `minDelta` in absolute terms are ignored. A 0.2 ms case
 *   that moves to 0.3 ms is a 50% "regression" of nothing.
 *
 * Microsecond cases get a wider tolerance than millisecond ones: fewer, shorter
 * operations fit in one sample, so they wobble more.
 */
export function compare(
  results: readonly CaseResult[],
  baseline: Baseline | null,
  options: { tolerance?: number } = {}
): Row[] {
  return results.map((result) => {
    const recorded = baseline?.cases[result.id]
    const tolerance =
      options.tolerance ??
      result.tolerance ??
      (result.unit === 'µs' ? 0.25 : result.unit === 'MB' ? 0.2 : 0.15)
    const overBudget = result.budget !== undefined && result.median > result.budget
    if (overBudget) {
      return {
        result,
        baseline: recorded?.median,
        deltaPct:
          recorded === undefined ? undefined : ((result.median - recorded.median) / recorded.median) * 100,
        status: 'over'
      }
    }
    if (!recorded || recorded.unit !== result.unit) {
      return { result, status: 'new' }
    }
    const minDelta = result.unit === 'µs' ? 5 : result.unit === 'MB' ? 8 : 0.5
    const delta = result.median - recorded.median
    const deltaPct = (delta / recorded.median) * 100
    const slower =
      delta > minDelta && deltaPct > tolerance * 100 && result.min > recorded.min * (1 + tolerance)
    if (slower) return { result, baseline: recorded.median, deltaPct, status: 'slow' }
    const faster =
      -delta > minDelta &&
      deltaPct < -tolerance * 100 &&
      result.min < recorded.min * (1 - tolerance)
    if (faster) return { result, baseline: recorded.median, deltaPct, status: 'faster' }
    return { result, baseline: recorded.median, deltaPct, status: 'ok' }
  })
}

function formatValue(value: number, unit: Unit): string {
  if (unit === 'MB') return value.toFixed(0)
  if (value >= 100) return value.toFixed(0)
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

const STATUS_LABEL: Record<Status, string> = {
  ok: 'ok',
  faster: 'faster',
  slow: 'SLOWER',
  over: 'OVER BUDGET',
  new: 'new',
  // `n/a` is not produced here; a case without a baseline is `new`.
}

/** The report, as plain text. One case per line so a diff is readable. */
export function renderTable(rows: readonly Row[], baseline: Baseline | null): string {
  const idWidth = Math.max(12, ...rows.map((row) => row.result.id.length)) + 2
  const lines: string[] = []
  lines.push(
    `${pad('case', idWidth)}${padStart('now', 10)}  ${pad('unit', 4)}${padStart('baseline', 10)}  ${padStart('delta', 8)}  ${padStart('budget', 9)}  status`
  )
  for (const row of rows) {
    const { result } = row
    const delta =
      row.deltaPct === undefined
        ? '—'
        : `${row.deltaPct > 0 ? '+' : ''}${row.deltaPct.toFixed(0)}%`
    lines.push(
      `${pad(result.id, idWidth)}${padStart(formatValue(result.median, result.unit), 10)}  ${pad(result.unit, 4)}` +
        `${padStart(row.baseline === undefined ? '—' : formatValue(row.baseline, result.unit), 10)}  ${padStart(delta, 8)}` +
        `  ${padStart(result.budget === undefined ? '—' : formatValue(result.budget, result.unit), 9)}  ${STATUS_LABEL[row.status]}`
    )
  }
  if (baseline === null) {
    lines.push('')
    lines.push('no baseline yet: run with --update to record this run')
  }
  return lines.join('\n')
}

export function summarise(rows: readonly Row[]): {
  total: number
  slow: number
  over: number
  fresh: number
  faster: number
  failed: boolean
} {
  const count = (status: Status): number => rows.filter((row) => row.status === status).length
  const slow = count('slow')
  const over = count('over')
  return {
    total: rows.length,
    slow,
    over,
    fresh: count('new'),
    faster: count('faster'),
    failed: slow > 0 || over > 0
  }
}
