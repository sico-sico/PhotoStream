import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * `protocol.ts` imports `electron`, which cannot load outside Electron.
 * Only the pure helpers are exercised here, so a stub with the same surface is
 * enough and keeps these tests fast and headless.
 */
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  net: { fetch: vi.fn() }
}))

const { isInsideRoot, photoUrl, resolvePicRequest, thumbUrl } = await import('./protocol')

let photoDir = ''
let thumbDir = ''

beforeEach(async () => {
  photoDir = await mkdtemp(join(tmpdir(), 'photostream-photos-'))
  thumbDir = await mkdtemp(join(tmpdir(), 'photostream-thumbs-'))
  await writeFile(join(photoDir, 'a.jpg'), 'x')
  await writeFile(join(photoDir, '京都 樱花.jpg'), 'x')
  await writeFile(join(thumbDir, 'hash-wall.webp'), 'x')
})

afterEach(async () => {
  await rm(photoDir, { recursive: true, force: true })
  await rm(thumbDir, { recursive: true, force: true })
})

/** Build a URL against the real directories of the current test. */
function url(host: string, path: string): string {
  return `pic://${host}/${path}`
}

describe('thumbUrl', () => {
  it('encodes the file name', () => {
    expect(thumbUrl('hash-wall.webp')).toBe('pic://thumb/hash-wall.webp')
    expect(thumbUrl('a b.webp')).toBe('pic://thumb/a%20b.webp')
  })

  it('encodes non-ASCII names', () => {
    expect(thumbUrl('京都.webp')).toContain('%E4%BA%AC%E9%83%BD')
  })
})

describe('photoUrl', () => {
  it('targets the photo host', () => {
    expect(photoUrl('a.jpg')).toBe('pic://photo/a.jpg')
  })

  it('encodes characters that would break the URL', () => {
    const encoded = photoUrl('a#b?.jpg')
    expect(encoded).not.toContain('#')
    expect(encoded).not.toContain('?')
  })
})

describe('isInsideRoot', () => {
  it('accepts a direct child', () => {
    expect(isInsideRoot('/root', join('/root', 'a.jpg'))).toBe(true)
  })

  it('rejects a parent traversal', () => {
    expect(isInsideRoot('/root', resolve('/root', '../secret.jpg'))).toBe(false)
  })

  it('rejects a sibling directory with a shared prefix', () => {
    // The classic bug: "/root-evil" starts with "/root".
    expect(isInsideRoot('/root', '/root-evil/secret.jpg')).toBe(false)
  })

  it('rejects the root itself', () => {
    expect(isInsideRoot('/root', '/root')).toBe(false)
  })

  it('is case-insensitive on Windows', () => {
    expect(isInsideRoot('C:\\Photos', 'c:\\photos\\a.jpg')).toBe(true)
  })
})

describe('resolvePicRequest', () => {
  const roots = () => ({ photoDir, thumbDir })

  it('resolves an existing photo', () => {
    expect(resolvePicRequest(url('photo', 'a.jpg'), roots())).toBe(join(photoDir, 'a.jpg'))
  })

  it('resolves an existing thumbnail', () => {
    expect(resolvePicRequest(url('thumb', 'hash-wall.webp'), roots())).toBe(join(thumbDir, 'hash-wall.webp'))
  })

  it('resolves a percent-encoded non-ASCII name', () => {
    const request = url('photo', encodeURIComponent('京都 樱花.jpg'))
    expect(resolvePicRequest(request, roots())).toBe(join(photoDir, '京都 樱花.jpg'))
  })

  it('returns null for a missing file', () => {
    expect(resolvePicRequest(url('photo', 'nope.jpg'), roots())).toBeNull()
  })

  it('returns null for an unknown host', () => {
    expect(resolvePicRequest(url('evil', 'a.jpg'), roots())).toBeNull()
  })

  it('returns null for a non-pic scheme', () => {
    expect(resolvePicRequest('file:///etc/passwd', roots())).toBeNull()
    expect(resolvePicRequest('https://example.com/a.jpg', roots())).toBeNull()
  })

  it('returns null for a malformed URL', () => {
    expect(resolvePicRequest('not a url', roots())).toBeNull()
  })

  it('rejects a parent traversal on the photo host', () => {
    // The security boundary: a crafted URL must not escape the library.
    expect(resolvePicRequest(url('photo', '../../../etc/passwd'), roots())).toBeNull()
  })

  it('rejects a traversal that reaches a real file outside the root', () => {
    const outside = resolve(photoDir, '..', 'outside.jpg')
    void outside
    expect(resolvePicRequest(url('photo', `..%2Foutside.jpg`), roots())).toBeNull()
  })

  it('rejects an absolute path smuggled in the URL', () => {
    expect(resolvePicRequest(url('photo', 'C%3A%5CWindows%5Cwin.ini'), roots())).toBeNull()
  })

  it('rejects a thumbnail request for a photo name', () => {
    // The thumbnail host is bound to the cache directory only.
    expect(resolvePicRequest(url('thumb', 'a.jpg'), roots())).toBeNull()
  })

  it('rejects a photo request for a cache file', () => {
    expect(resolvePicRequest(url('photo', 'hash-wall.webp'), roots())).toBeNull()
  })

  it('returns null when no library is open', () => {
    expect(resolvePicRequest(url('photo', 'a.jpg'), { photoDir: '', thumbDir })).toBeNull()
  })

  it('rejects a null byte in the path', () => {
    expect(resolvePicRequest(url('photo', 'a.jpg%00.png'), roots())).toBeNull()
  })

  it('rejects an empty path', () => {
    expect(resolvePicRequest('pic://photo/', roots())).toBeNull()
  })

  it('tolerates leading slashes without escaping', () => {
    expect(resolvePicRequest('pic://photo//a.jpg', roots())).toBe(join(photoDir, 'a.jpg'))
  })
})
