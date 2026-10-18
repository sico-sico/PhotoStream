import { describe, expect, it } from 'vitest'
import type { Photo } from './types'
import { applyFilters, dateRange, isFilterActive, normalizeFilters } from './filters'

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
  it('lower-cases and trims the search text', () => {
    const bounds = normalizeFilters({ from: '', to: '', text: '  KyOtO  ' })
    expect(bounds.text).toBe('kyoto')
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
