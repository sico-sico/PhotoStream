import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { resolveDropTarget } from './drop'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'photostream-drop-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveDropTarget', () => {
  it('opens a dropped directory as itself', async () => {
    const nested = join(root, 'photos')
    await mkdir(nested)

    expect(await resolveDropTarget(nested)).toBe(nested)
  })

  it('opens the folder that contains a dropped photo', async () => {
    const photo = join(root, 'IMG_0001.jpg')
    await writeFile(photo, 'not really a jpeg')

    // The extension decides, not the file contents: decoding every dropped file
    // to check it would make a drop feel slow.
    expect(await resolveDropTarget(photo)).toBe(root)
  })

  it('accepts .jpeg as well as .jpg', async () => {
    const photo = join(root, 'IMG_0002.JPEG')
    await writeFile(photo, 'x')

    expect(await resolveDropTarget(photo)).toBe(root)
  })

  it('rejects a file that is not a photo', async () => {
    const other = join(root, 'notes.txt')
    await writeFile(other, 'x')

    await expect(resolveDropTarget(other)).rejects.toThrow(/not a folder of photos/)
  })

  it('rejects a path that does not exist', async () => {
    await expect(resolveDropTarget(join(root, 'missing'))).rejects.toThrow(/no longer exists/)
  })

  it('rejects an empty path', async () => {
    await expect(resolveDropTarget('   ')).rejects.toThrow(/Nothing was dropped/)
  })

  it('trims surrounding whitespace before resolving', async () => {
    const photo = join(root, 'IMG_0003.jpg')
    await writeFile(photo, 'x')

    // Explorer can hand over a path with a trailing newline on some platforms.
    expect(await resolveDropTarget(`  ${photo}  `)).toBe(root)
  })

  it('returns an absolute path even for a relative input', async () => {
    const nested = join(root, 'rel')
    await mkdir(nested)
    const fromHere = relative(process.cwd(), nested)

    expect(await resolveDropTarget(fromHere)).toBe(nested)
  })
})
