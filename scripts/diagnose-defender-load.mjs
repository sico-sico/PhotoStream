// Does opening a folder make Defender work?
//
// Photos are a large, previously-unseen read: 512 KB per photo from a 42 GB
// library is ~1.6 GB of I/O. Defender's real-time protection sits in the file
// system filter and scans reads, so it *should* show up. This samples its CPU and
// I/O counters at 200 ms while the scan runs, next to a control process that does
// no scanning.
//
// The cache is emptied first, because a cached scan reads almost nothing and
// would make Defender look idle for the wrong reason.
//
// Usage: node scripts/diagnose-defender-load.mjs <photoDir>
import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const photoDir = process.argv[2]
if (!photoDir) {
  console.error('usage: node scripts/diagnose-defender-load.mjs <photoDir>')
  process.exit(1)
}

const userDataDir = await mkdtemp(join(tmpdir(), 'photostream-defender2-'))
const dataDir = join(userDataDir, 'PhotoStreamData')
// Fresh directory: no metadata.db, so every photo is read.
await mkdir(dataDir, { recursive: true })
await writeFile(
  join(dataDir, 'settings.json'),
  JSON.stringify(
    { lastDir: '', layout: 'grid', sort: 'taken-desc', filters: { from: '', to: '', text: '' }, locale: 'en', history: [], recursive: false },
    null,
    2
  ),
  'utf-8'
)

/** Snapshot the counters that reveal whether Defender is scanning. */
function sample() {
  return new Promise((resolve) => {
    const script = `
      $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -like 'MsMpEng*' } | Select-Object -First 1
      $c = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -like 'explorer*' } | Select-Object -First 1
      [pscustomobject]@{
        defenderCpu = [int]$p.PercentProcessorTime
        defenderReadOps = [int]$p.IOReadOperationsPersec
        defenderReadBytes = [long]$p.IOReadBytesPersec
        explorerCpu = [int]$c.PercentProcessorTime
      } | ConvertTo-Json -Compress
    `
    execFile('powershell', ['-NoProfile', '-Command', script], (error, stdout) => {
      if (error) return resolve(null)
      try {
        resolve(JSON.parse(String(stdout).trim()))
      } catch {
        resolve(null)
      }
    })
  })
}

const app = await electron.launch({
  args: [join(process.cwd(), 'out', 'main', 'index.js')],
  env: { ...process.env, PHOTOSTREAM_USER_DATA: userDataDir }
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(3000)

const samples = []
let scanning = true
const collect = (async () => {
  while (scanning) {
    const s = await sample()
    if (s) samples.push(s)
    await new Promise((r) => setTimeout(r, 200))
  }
})()

const started = Date.now()
const result = await page.evaluate(async (dir) => {
  const scan = await window.photoStream.openDirectory(dir, false)
  return { photos: scan.photos.length, durationMs: scan.durationMs }
}, photoDir)
const elapsed = Date.now() - started

// Keep sampling briefly after the scan: Defender often scans on close.
await new Promise((r) => setTimeout(r, 2500))
scanning = false
await collect

// Wait for the app to finish any queued work before tearing down.
await page.waitForTimeout(1000)

const max = (key) => Math.max(0, ...samples.map((s) => s[key] ?? 0))
const mean = (key) => {
  const values = samples.map((s) => s[key] ?? 0)
  return Math.round((values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)) * 10) / 10
}

console.log(
  JSON.stringify(
    {
      scan: { ...result, wallClockMs: elapsed },
      samples: samples.length,
      defender: {
        peakCpuPercent: max('defenderCpu'),
        meanCpuPercent: mean('defenderCpu'),
        peakReadOpsPerSec: max('defenderReadOps'),
        peakReadMBps: Math.round((max('defenderReadBytes') / (1024 * 1024)) * 10) / 10
      },
      explorerControl: {
        peakCpuPercent: max('explorerCpu'),
        meanCpuPercent: mean('explorerCpu')
      }
    },
    null,
    2
  )
)

await app.close()
await rm(userDataDir, { recursive: true, force: true })
