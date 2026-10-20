#!/usr/bin/env node
/**
 * How much read concurrency does a scan actually want?
 *
 * `SCAN_CONCURRENCY` in `src/main/scanner.ts` is 16, and the reason it is 16
 * rather than 8 is *not* "16 was fastest" — this script exists because that
 * claim was wrong once and took a comment and a paragraph of documentation with
 * it. What the sweep shows is a plateau starting at 6–8, flat out to 64.
 *
 * Reproduce the numbers in the scanner's comment:
 *
 *   node --import tsx scripts/bench/sweep.ts
 *
 * To see whether the plateau tracks CPU count, pin the process's affinity and
 * run again. Child processes inherit it, which is why this works from a shell:
 *
 *   (Get-Process -Id $PID).ProcessorAffinity = 0x0F   # 4 logical CPUs
 *   node --import tsx scripts/bench/sweep.ts
 *
 * The scan is repeated with an empty metadata cache each time, because a warm
 * cache answers without touching the file and would measure nothing.
 */
import { rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanDirectory } from '../../src/main/scanner'
import { MetadataCache } from '../../src/main/metadata-cache'
import { ensureFixtures } from './fixtures'

const CONCURRENCIES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]
const RUNS = 5

const elapsed = (since: bigint): number => Number(process.hrtime.bigint() - since) / 1e6

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Remove a SQLite database and the WAL files it leaves behind. */
async function removeDatabase(path: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true })
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? join(tmpdir(), 'photostream-bench')
  const fixtures = await ensureFixtures(root)
  const scratch = join(root, 'sweep')
  await mkdir(scratch, { recursive: true })

  const scan = async (concurrency: number): Promise<number> => {
    const path = join(scratch, 'sweep.db')
    await removeDatabase(path)
    const cache = new MetadataCache(path)
    try {
      const since = process.hrtime.bigint()
      await scanDirectory(fixtures.lib4000, { recursive: true, cache, concurrency })
      return elapsed(since)
    } finally {
      cache.close()
      await removeDatabase(path)
    }
  }

  // Timers keep firing during the scan, so a starved event loop shows up as a
  // gap. The main process serves IPC on that loop; if 64 workers blocked it, the
  // choice of 16 would matter for reasons other than throughput.
  const loopGaps = async (concurrency: number): Promise<{ ms: number; p95: number }> => {
    const path = join(scratch, 'lag.db')
    await removeDatabase(path)
    const cache = new MetadataCache(path)
    const gaps: number[] = []
    let last = process.hrtime.bigint()
    const timer = setInterval(() => {
      const now = process.hrtime.bigint()
      gaps.push(Number(now - last) / 1e6)
      last = now
    }, 10)
    try {
      const since = process.hrtime.bigint()
      await scanDirectory(fixtures.lib4000, { recursive: true, cache, concurrency })
      const ms = elapsed(since)
      gaps.sort((a, b) => a - b)
      return { ms, p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0 }
    } finally {
      clearInterval(timer)
      cache.close()
      await removeDatabase(path)
    }
  }

  console.log(`scanDirectory, ${fixtures.lib4000}`)
  console.log(`median of ${RUNS} runs, empty metadata cache each time\n`)
  console.log('concurrency   median    best   speedup')

  const results: Array<{ concurrency: number; median: number; best: number }> = []
  for (const concurrency of CONCURRENCIES) {
    // Discarded: the first pass over the tree pays for the OS file cache.
    await scan(concurrency)
    const runs: number[] = []
    for (let index = 0; index < RUNS; index++) runs.push(await scan(concurrency))
    results.push({ concurrency, median: median(runs), best: Math.min(...runs) })
  }

  const baseline = results[0].median
  for (const row of results) {
    console.log(
      `${String(row.concurrency).padStart(11)}   ${row.median.toFixed(0).padStart(6)}   ${row.best
        .toFixed(0)
        .padStart(4)}   ${(baseline / row.median).toFixed(2)}x`
    )
  }

  const best = results.reduce((a, b) => (b.median < a.median ? b : a))
  console.log(`\nbest at c=${best.concurrency}: ${best.median.toFixed(0)} ms`)

  console.log('\nevent-loop lag during the scan (10 ms timer)')
  for (const concurrency of [8, 16, 32, 64]) {
    const row = await loopGaps(concurrency)
    console.log(`  c=${String(concurrency).padEnd(3)} scan ${row.ms.toFixed(0).padStart(4)} ms   gap p95 ${row.p95.toFixed(1)} ms`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
