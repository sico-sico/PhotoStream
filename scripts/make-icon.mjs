#!/usr/bin/env node
/**
 * Render `build/icon.svg` into the icon files Electron and Windows expect.
 *
 * `sharp` renders the PNGs but cannot write ICO, and the alternative
 * (`png-to-ico`, `to-ico`) pulls in old image libraries for what is a 6-byte
 * header plus a directory of PNG payloads. Writing those 22 bytes here keeps a
 * build-time-only concern out of the dependency tree.
 *
 * The ICO is PNG-compressed rather than BMP: every Windows version that runs
 * this app (Electron 44 needs Windows 10 1809+) supports PNG entries, and they
 * are far smaller than uncompressed 256x256 bitmaps.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const source = join(buildDir, 'icon.svg')

/**
 * Sizes Windows and Electron actually use.
 *
 * 16 and 32 are the taskbar and title bar, 48 and 64 the file-explorer and
 * alt-tab views, 128 and 256 the large-icon and high-DPI cases. Each is rendered
 * from the vector rather than downscaled from one bitmap, so the small ones stay
 * crisp.
 */
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/** Build a PNG-compressed ICO container from a list of PNG buffers. */
function buildIco(images) {
  const HEADER_SIZE = 6
  const ENTRY_SIZE = 16

  const header = Buffer.alloc(HEADER_SIZE)
  // Reserved (0), type 1 = icon, image count.
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(ENTRY_SIZE * images.length)
  let offset = HEADER_SIZE + directory.length

  images.forEach((image, index) => {
    const at = index * ENTRY_SIZE
    // 256 is stored as 0: the width/height fields are a single byte.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at)
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1)
    // Palette size, reserved, colour planes, bits per pixel.
    directory.writeUInt8(0, at + 2)
    directory.writeUInt8(0, at + 3)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    // Payload length and position.
    directory.writeUInt32LE(image.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += image.png.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.png)])
}

async function main() {
  if (!existsSync(source)) throw new Error(`missing ${source}`)
  await mkdir(buildDir, { recursive: true })

  const svg = await readFile(source)

  // `density` raises the rasterisation resolution so the vector is redrawn at
  // each size instead of being resized from 512px.
  const images = await Promise.all(
    SIZES.map(async (size) => ({
      size,
      png: await sharp(svg, { density: Math.max(72, Math.ceil((size / 512) * 72 * 8)) })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer()
    }))
  )

  const ico = buildIco(images)
  await writeFile(join(buildDir, 'icon.ico'), ico)

  // Electron can take a PNG for the window icon on Windows, and a 256px one is
  // what the taskbar asks for.
  await writeFile(join(buildDir, 'icon.png'), images[images.length - 1].png)

  console.log(`icon.ico  ${(ico.length / 1024).toFixed(1)} KB  (${SIZES.join(', ')} px)`)
  console.log(`icon.png  ${(images[images.length - 1].png.length / 1024).toFixed(1)} KB  (256 px)`)
}

await main()
