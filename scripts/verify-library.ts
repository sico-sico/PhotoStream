/**
 * Manual verification against a real photo library.
 *
 * Not part of the automated suite: it needs the user's own photos, so it is
 * opt-in via an argument or `PHOTO_LIBRARY_DIR`. It reports how many files yield
 * a capture date and how long the pass takes, which is the number that decides
 * whether scanning can keep up with the folder-open interaction.
 *
 * Runs the real source through `tsx`, not the bundled output, so what is
 * measured is the code that ships.
 *
 * Usage: npm run verify:library -- "D:\path\to\photos"
 */
import { readdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { readImageMetadata } from '../src/main/metadata'

async function main(): Promise<void> {
  const dir = process.argv[2] || process.env.PHOTO_LIBRARY_DIR
  if (!dir) {
    console.error('Usage: npm run verify:library -- <photo-dir>')
    process.exitCode = 1
    return
  }

  const entries = await readdir(dir)
  const files = entries.filter((name) => /\.jpe?g$/i.test(extname(name)))

  if (files.length === 0) {
    console.error(`No JPEGs found in ${dir}`)
    process.exitCode = 1
    return
  }

  let withDate = 0
  let withoutDate = 0
  let zeroSize = 0
  let totalBytes = 0
  const samples: Array<{ name: string; w: number; h: number; takenAt: string }> = []
  const allDates: string[] = []

  const started = Date.now()
  for (const name of files) {
    const path = join(dir, name)
    const info = await stat(path)
    totalBytes += info.size
    try {
      const meta = await readImageMetadata(path)
      if (meta.takenAt) {
        withDate++
        allDates.push(meta.takenAt)
        if (samples.length < 5) {
          samples.push({ name: name.slice(0, 46), w: meta.width, h: meta.height, takenAt: meta.takenAt })
        }
      } else {
        withoutDate++
      }
      if (meta.width === 0 || meta.height === 0) zeroSize++
    } catch {
      withoutDate++
    }
  }
  const elapsed = Date.now() - started

  allDates.sort()

  console.log(`files:             ${files.length}`)
  console.log(`total size:        ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)} GB`)
  console.log(`with EXIF date:    ${withDate}`)
  console.log(`without EXIF date: ${withoutDate}`)
  console.log(`unreadable size:   ${zeroSize}`)
  console.log(`date range:        ${allDates[0] ?? '-'} .. ${allDates.at(-1) ?? '-'}`)
  console.log(`elapsed:           ${elapsed} ms (${(elapsed / files.length).toFixed(2)} ms/photo)`)
  console.log('samples:')
  for (const sample of samples) console.log('  ', sample)
}

void main()
