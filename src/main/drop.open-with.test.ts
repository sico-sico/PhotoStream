import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { photoFromArgv, resolveOpenTarget } from './drop'

/**
 * "Open this photo" from outside the app.
 *
 * Both entry points — dropping a file on the window and Explorer's
 * "Open with → PhotoStream" — resolve to the same thing: a folder plus the photo
 * to focus. These tests pin that contract, because the two paths would otherwise
 * drift (the drop one returning a folder only, the argv one forgetting to focus).
 */

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'photostream-open-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveOpenTarget', () => {
  it('returns a folder with nothing to focus', async () => {
    const nested = join(root, 'photos')
    await mkdir(nested)

    expect(await resolveOpenTarget(nested)).toEqual({ dir: nested, photo: '' })
  })

  it('returns the containing folder and the photo itself', async () => {
    const photo = join(root, 'IMG_0001.jpg')
    await writeFile(photo, 'x')

    // This is what makes "open this picture" land on the picture rather than on
    // the newest photo in the folder.
    expect(await resolveOpenTarget(photo)).toEqual({ dir: root, photo })
  })

  it('accepts .jpeg as well as .jpg', async () => {
    const photo = join(root, 'IMG_0002.JPEG')
    await writeFile(photo, 'x')

    expect(await resolveOpenTarget(photo)).toEqual({ dir: root, photo })
  })

  it('accepts a PNG', async () => {
    const photo = join(root, 'screenshot.PNG')
    await writeFile(photo, 'x')

    expect(await resolveOpenTarget(photo)).toEqual({ dir: root, photo })
  })

  it('still rejects a non-JPEG file', async () => {
    const other = join(root, 'notes.txt')
    await writeFile(other, 'x')

    await expect(resolveOpenTarget(other)).rejects.toThrow(/not a folder of photos/)
  })
})

describe('photoFromArgv', () => {
  it('finds the photo among Electron\'s own flags', () => {
    // A packaged launch looks roughly like this; only the last entry matters.
    const argv = [
      'C:\\Apps\\PhotoStream.exe',
      '--allow-file-access-from-files',
      '--user-data-dir=C:\\Temp\\x',
      'C:\\Photos\\IMG_0001.jpg'
    ]
    expect(photoFromArgv(argv)).toBe('C:\\Photos\\IMG_0001.jpg')
  })

  it('ignores the development entry script', () => {
    // In development argv[1] is the built main file, not a path the user chose.
    const argv = ['electron.exe', 'out/main/index.js', 'D:\\photos\\a.jpg']
    expect(photoFromArgv(argv)).toBe('D:\\photos\\a.jpg')
  })

  it('returns nothing for a plain launch', () => {
    expect(photoFromArgv(['C:\\Apps\\PhotoStream.exe'])).toBe('')
    expect(photoFromArgv(['C:\\Apps\\PhotoStream.exe', '--inspect'])).toBe('')
  })

  it('ignores arguments that are not images', () => {
    const argv = ['app.exe', 'readme.txt', 'folder', 'photo.jpg']
    expect(photoFromArgv(argv)).toBe('photo.jpg')
  })

  it('is case-insensitive about the extension', () => {
    expect(photoFromArgv(['app.exe', 'DSC_0001.JPG'])).toBe('DSC_0001.JPG')
  })

  it('takes only the first photo when several are given', () => {
    // The wall shows one folder at a time, so several files have no single
    // meaning; the first is the one Windows lists first.
    const argv = ['app.exe', 'a.jpg', 'b.jpg']
    expect(photoFromArgv(argv)).toBe('a.jpg')
  })

  it('does not treat a flag with an image-looking value as a photo', () => {
    expect(photoFromArgv(['app.exe', '--config=a.jpg'])).toBe('')
  })
})
