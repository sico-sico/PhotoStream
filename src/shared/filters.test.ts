import { describe, expect, it } from 'vitest'
import type { Photo } from './types'
import { MAX_PATTERN_LENGTH, applyFilters, compileNamePattern, dateRange, isFilterActive, normalizeFilters } from './filters'

function photo(id: string, name: string, takenAt: string): Photo {
  return { id, path: `/photos/${name}`, name, width: 100, height: 100, takenAt, dateSource: takenAt ? 'exif' : 'none', mtimeMs: 0, sizeBytes: 0 }
}

const photos: Photo[] = [
  photo('a', '2019-07-14 Kyoto #A.jpg', '2019-07-14'),
  photo('b', '2020-01-05 Paris #B.jpg', '2020-01-05'),
  photo('c', 'undated-scan.jpg', ''),
  photo('d', '2024-03-11 Kyoto Temple #D.jpg', '2024-03-11')
]

describe('normalizeFilters', () => {
  it('trims the search text but keeps its case', () => {
    // Case folding belongs to the matcher, not to normalisation: the compiled
    // pattern is what compares against names, and folding twice would make the
    // stored value differ from what the user typed for no benefit.
    const bounds = normalizeFilters({ from: '', to: '', text: '  KyOtO  ' })
    expect(bounds.text).toBe('KyOtO')
  })

  it('normalises date bounds and drops invalid ones', () => {
    expect(normalizeFilters({ from: '2024-3-1', to: 'nope', text: '' })).toEqual({
      from: '2024-03-01',
      to: '',
      text: ''
    })
  })
})

describe('isFilterActive', () => {
  it('is false for an empty filter set', () => {
    expect(isFilterActive({ from: '', to: '', text: '' })).toBe(false)
  })

  it('is true when any bound is set', () => {
    expect(isFilterActive({ from: '2024-01-01', to: '', text: '' })).toBe(true)
    expect(isFilterActive({ from: '', to: '2024-01-01', text: '' })).toBe(true)
    expect(isFilterActive({ from: '', to: '', text: 'kyoto' })).toBe(true)
  })
})

describe('applyFilters', () => {
  it('returns every photo when inactive', () => {
    expect(applyFilters(photos, { from: '', to: '', text: '' })).toHaveLength(4)
  })

  it('returns a copy rather than the input array', () => {
    const result = applyFilters(photos, { from: '', to: '', text: '' })
    expect(result).not.toBe(photos)
    expect(result).toEqual(photos)
  })

  it('matches the file name case-insensitively', () => {
    const result = applyFilters(photos, { from: '', to: '', text: 'kyoto' })
    expect(result.map((p) => p.id)).toEqual(['a', 'd'])
  })

  it('treats the date bounds as inclusive', () => {
    expect(applyFilters(photos, { from: '2019-07-14', to: '', text: '' }).map((p) => p.id)).toEqual(['a', 'b', 'd'])
    expect(applyFilters(photos, { from: '', to: '2020-01-05', text: '' }).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('combines a date range with a text search', () => {
    const result = applyFilters(photos, { from: '2020-01-01', to: '2024-12-31', text: 'kyoto' })
    expect(result.map((p) => p.id)).toEqual(['d'])
  })

  it('excludes undated photos once a date bound is set', () => {
    // Undated files would otherwise match every range, which would be a lie.
    const result = applyFilters(photos, { from: '1900-01-01', to: '2100-01-01', text: '' })
    expect(result.map((p) => p.id)).not.toContain('c')
  })

  it('keeps undated photos when only a text filter is set', () => {
    const result = applyFilters(photos, { from: '', to: '', text: 'scan' })
    expect(result.map((p) => p.id)).toEqual(['c'])
  })

  it('returns nothing for an impossible range', () => {
    expect(applyFilters(photos, { from: '2100-01-01', to: '2100-12-31', text: '' })).toEqual([])
  })

  it('ignores an inverted range by matching nothing', () => {
    // from > to is legal to type; it simply selects nothing.
    expect(applyFilters(photos, { from: '2024-01-01', to: '2020-01-01', text: '' })).toEqual([])
  })

  it('tolerates an invalid date bound by ignoring it', () => {
    const result = applyFilters(photos, { from: 'garbage', to: '', text: '' })
    expect(result).toHaveLength(4)
  })

  it('filters by wildcard pattern over the whole file name', () => {
    const result = applyFilters(photos, { from: '', to: '', text: '*Kyoto*' })
    expect(result.map((p) => p.id)).toEqual(['a', 'd'])
  })

  it('filters by extension with a wildcard', () => {
    const all = applyFilters(photos, { from: '', to: '', text: '*.jpg' })
    // Every fixture ends in .jpg, so the pattern must not exclude any of them.
    expect(all).toHaveLength(4)
    expect(applyFilters(photos, { from: '', to: '', text: '*.png' })).toEqual([])
  })

  it('combines a wildcard with a date range', () => {
    const result = applyFilters(photos, { from: '2020-01-01', to: '2024-12-31', text: '*Kyoto*' })
    expect(result.map((p) => p.id)).toEqual(['d'])
  })
})

describe('compileNamePattern', () => {
  it('matches everything for an empty pattern', () => {
    expect(compileNamePattern('')('anything.jpg')).toBe(true)
    expect(compileNamePattern('   ')('anything.jpg')).toBe(true)
  })

  it('matches a substring when there is no wildcard', () => {
    const matches = compileNamePattern('kyoto')
    expect(matches('2019 Kyoto Temple.jpg')).toBe(true)
    expect(matches('Paris.jpg')).toBe(false)
  })

  it('is case-insensitive in both modes', () => {
    expect(compileNamePattern('KYOTO')('kyoto.jpg')).toBe(true)
    // Glob mode is anchored to the whole name, so the extension has to be part
    // of the pattern: `K*O` alone would not match `KYOTO.jpg`.
    expect(compileNamePattern('K*O.jpg')('KYOTO.jpg')).toBe(true)
    expect(compileNamePattern('K*O.jpg')('kyoto.jpg')).toBe(true)
  })

  it('anchors a wildcard pattern to the whole name', () => {
    // `*.jpg` must not match a name that merely contains `.jpg`.
    const matches = compileNamePattern('*.jpg')
    expect(matches('IMG_0001.jpg')).toBe(true)
    expect(matches('IMG_0001.jpg.bak')).toBe(false)
    expect(matches('jpg')).toBe(false)
  })

  it('lets * span zero or more characters', () => {
    const matches = compileNamePattern('IMG_*.jpg')
    expect(matches('IMG_0001.jpg')).toBe(true)
    expect(matches('IMG_.jpg')).toBe(true)
    expect(matches('DSC_0001.jpg')).toBe(false)
  })

  it('lets * span several segments', () => {
    expect(compileNamePattern('*kyoto*')('2019-07-14 Kyoto Temple #D.jpg')).toBe(true)
  })

  it('lets ? match exactly one character', () => {
    const matches = compileNamePattern('IMG_???.jpg')
    expect(matches('IMG_123.jpg')).toBe(true)
    expect(matches('IMG_12.jpg')).toBe(false)
    expect(matches('IMG_1234.jpg')).toBe(false)
  })

  it('escapes regex metacharacters in the pattern', () => {
    // Brackets, parentheses and dots are ordinary in photo file names; passing
    // them through unescaped would either throw or match something unintended.
    expect(compileNamePattern('IMG (1).jpg')('IMG (1).jpg')).toBe(true)
    expect(compileNamePattern('a+b.jpg')('a+b.jpg')).toBe(true)
    expect(compileNamePattern('[x].jpg')('[x].jpg')).toBe(true)
    // `[x]` must not behave as a character class.
    expect(compileNamePattern('[x].jpg')('x.jpg')).toBe(false)
  })

  it('treats a dot literally rather than as any character', () => {
    expect(compileNamePattern('*.jpg')('photoXjpg')).toBe(false)
  })

  it('does not let a pattern inject a regex alternation', () => {
    // `|` is literal, so this matches the literal name only.
    expect(compileNamePattern('a|b')('a|b')).toBe(true)
    expect(compileNamePattern('a|b')('a')).toBe(false)
  })

  it('caps the pattern length', () => {
    const long = `${'a'.repeat(MAX_PATTERN_LENGTH)}b`
    // The trailing `b` is beyond the cap, so it is not part of the needle.
    expect(compileNamePattern(long)('a'.repeat(MAX_PATTERN_LENGTH))).toBe(true)
  })
})

describe('dateRange', () => {
  it('reports the inclusive min and max', () => {
    expect(dateRange(photos)).toEqual({ min: '2019-07-14', max: '2024-03-11' })
  })

  it('ignores undated photos', () => {
    expect(dateRange([photos[2]])).toEqual({ min: '', max: '' })
  })

  it('handles an empty collection', () => {
    expect(dateRange([])).toEqual({ min: '', max: '' })
  })
})
