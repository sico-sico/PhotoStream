import { describe, expect, it } from 'vitest'
import type { Photo } from './types'
import { findPhoto, removePhoto, sortPhotos, upsertPhoto } from './photoStore'

function photo(path: string, takenAt: string, name = path.split('/').pop()!): Photo {
  return {
    id: path.toLowerCase(),
    path,
    name,
    width: 100,
    height: 100,
    takenAt,
    dateSource: takenAt ? 'exif' : 'none',
    mtimeMs: 0,
    sizeBytes: 0
  }
}

describe('sortPhotos', () => {
  it('defaults to newest first', () => {
    // A photo wall is a stream: the newest photo is the one a user came to see,
    // so it belongs at the top rather than after years of history.
    const result = sortPhotos([photo('/a', '2019-07-14'), photo('/b', '2020-01-05')])
    expect(result.map((p) => p.path)).toEqual(['/b', '/a'])
  })

  it('orders oldest first when asked', () => {
    const result = sortPhotos([photo('/b', '2020-01-05'), photo('/a', '2019-07-14')], 'taken-asc')
    expect(result.map((p) => p.path)).toEqual(['/a', '/b'])
  })

  it('breaks date ties by name', () => {
    const result = sortPhotos(
      [photo('/b', '2020-01-05', 'bravo.jpg'), photo('/a', '2020-01-05', 'alpha.jpg')],
      'taken-asc'
    )
    expect(result.map((p) => p.name)).toEqual(['alpha.jpg', 'bravo.jpg'])
  })

  it('reverses name order for same-day photos in the newest-first mode', () => {
    // Otherwise the newest day would silently read oldest-first inside itself.
    const result = sortPhotos(
      [photo('/a', '2020-01-05', 'alpha.jpg'), photo('/b', '2020-01-05', 'bravo.jpg')],
      'taken-desc'
    )
    expect(result.map((p) => p.name)).toEqual(['bravo.jpg', 'alpha.jpg'])
  })

  it('places undated photos last in either direction', () => {
    // They have no position in a timeline, so letting them lead the wall would
    // put the least informative photos at the very top.
    for (const mode of ['taken-desc', 'taken-asc'] as const) {
      const result = sortPhotos([photo('/u', ''), photo('/a', '2019-07-14')], mode)
      expect(result.map((p) => p.path)).toEqual(['/a', '/u'])
    }
  })

  it('orders undated photos among themselves by name', () => {
    const result = sortPhotos([photo('/z', '', 'zulu.jpg'), photo('/a', '', 'alpha.jpg')])
    expect(result.map((p) => p.name)).toEqual(['alpha.jpg', 'zulu.jpg'])
  })

  it('sorts by name and ignores the capture date', () => {
    // The user asked for file names; interleaving by date would look arbitrary.
    const photos = [photo('/b', '2020-01-05', 'bravo.jpg'), photo('/a', '2019-07-14', 'alpha.jpg')]
    expect(sortPhotos(photos, 'name-asc').map((p) => p.name)).toEqual(['alpha.jpg', 'bravo.jpg'])
    expect(sortPhotos(photos, 'name-desc').map((p) => p.name)).toEqual(['bravo.jpg', 'alpha.jpg'])
  })

  it('sorts undated photos by name in the name modes too', () => {
    const photos = [photo('/z', '', 'zulu.jpg'), photo('/a', '2019-07-14', 'alpha.jpg')]
    expect(sortPhotos(photos, 'name-asc').map((p) => p.name)).toEqual(['alpha.jpg', 'zulu.jpg'])
  })

  it('does not mutate the input', () => {
    const input = [photo('/b', '2020-01-05'), photo('/a', '2019-07-14')]
    const copy = [...input]
    sortPhotos(input)
    expect(input).toEqual(copy)
  })

  it('handles an empty array', () => {
    expect(sortPhotos([])).toEqual([])
  })
})

describe('upsertPhoto', () => {
  it('inserts a new photo in sorted position', () => {
    const existing = [photo('/a', '2019-07-14')]
    // The default is newest first, so the older photo lands at the end.
    const result = upsertPhoto(existing, photo('/b', '2020-01-05'))
    expect(result.map((p) => p.path)).toEqual(['/b', '/a'])
  })

  it('inserts in the order the caller asked for', () => {
    const existing = [photo('/b', '2020-01-05')]
    const result = upsertPhoto(existing, photo('/a', '2019-07-14'), 'taken-asc')
    expect(result.map((p) => p.path)).toEqual(['/a', '/b'])
  })

  it('replaces an existing photo matched by path', () => {
    const existing = [photo('/a', '2019-07-14')]
    const updated = { ...photo('/a', '2021-01-01') }
    const result = upsertPhoto(existing, updated)
    expect(result).toHaveLength(1)
    expect(result[0].takenAt).toBe('2021-01-01')
  })

  it('does not mutate the input', () => {
    const existing = [photo('/a', '2019-07-14')]
    upsertPhoto(existing, photo('/b', '2020-01-05'))
    expect(existing).toHaveLength(1)
  })

  it('treats a renamed file as a new photo', () => {
    // Path is the identity in a filesystem-backed wall, so a rename must not
    // silently overwrite the old entry.
    const existing = [photo('/a.jpg', '2019-07-14')]
    const result = upsertPhoto(existing, photo('/b.jpg', '2019-07-14'))
    expect(result).toHaveLength(2)
  })
})

describe('removePhoto', () => {
  it('removes the matching photo', () => {
    const result = removePhoto([photo('/a', '2019-07-14'), photo('/b', '2020-01-05')], '/a')
    expect(result.map((p) => p.path)).toEqual(['/b'])
  })

  it('returns a copy when nothing matches', () => {
    const input = [photo('/a', '2019-07-14')]
    const result = removePhoto(input, '/nope')
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
  })
})

describe('findPhoto', () => {
  it('finds by exact path', () => {
    const photos = [photo('/a', '2019-07-14')]
    expect(findPhoto(photos, '/a')?.path).toBe('/a')
  })

  it('returns undefined for a miss', () => {
    expect(findPhoto([photo('/a', '2019-07-14')], '/b')).toBeUndefined()
  })
})
