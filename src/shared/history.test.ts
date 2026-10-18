import { describe, expect, it } from 'vitest'
import {
  MAX_HISTORY,
  addToHistory,
  folderName,
  historyKey,
  removeFromHistory,
  sanitizeHistory
} from './history'

describe('historyKey', () => {
  it('ignores case, which Windows paths do not distinguish', () => {
    expect(historyKey('C:\\Photos\\Trip')).toBe(historyKey('c:\\photos\\trip'))
  })

  it('ignores a trailing separator', () => {
    expect(historyKey('/photos/trip/')).toBe(historyKey('/photos/trip'))
    expect(historyKey('C:\\Photos\\Trip\\')).toBe(historyKey('C:\\Photos\\Trip'))
  })

  it('ignores surrounding whitespace', () => {
    expect(historyKey('  /photos  ')).toBe('/photos')
  })
})

describe('addToHistory', () => {
  it('puts a new folder first', () => {
    expect(addToHistory([], '/a')).toEqual(['/a'])
    expect(addToHistory(['/a'], '/b')).toEqual(['/b', '/a'])
  })

  it('moves an existing folder to the front instead of duplicating it', () => {
    expect(addToHistory(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b'])
  })

  it('treats a differently-cased copy of the same path as a duplicate', () => {
    // Otherwise the menu would show what looks like the same folder twice.
    expect(addToHistory(['C:\\Photos'], 'c:\\photos')).toEqual(['c:\\photos'])
  })

  it('treats a trailing separator as the same folder', () => {
    expect(addToHistory(['/photos'], '/photos/')).toEqual(['/photos/'])
  })

  it('ignores an empty folder', () => {
    expect(addToHistory(['/a'], '   ')).toEqual(['/a'])
  })

  it('caps the list, dropping the oldest', () => {
    const many = Array.from({ length: MAX_HISTORY }, (_, index) => `/p${index}`)
    const result = addToHistory(many, '/new')
    expect(result).toHaveLength(MAX_HISTORY)
    expect(result[0]).toBe('/new')
    // The last of the previous entries is the one that falls off.
    expect(result).not.toContain(`/p${MAX_HISTORY - 1}`)
  })

  it('honours a custom limit', () => {
    expect(addToHistory(['/a', '/b'], '/c', 2)).toEqual(['/c', '/a'])
  })

  it('does not mutate the input', () => {
    const original = ['/a']
    addToHistory(original, '/b')
    expect(original).toEqual(['/a'])
  })

  it('stores the path as given, preserving the caller’s spelling', () => {
    // The key is normalised but what is displayed and re-opened is not: a user
    // who picked `D:\Photos` should not see it rewritten to lowercase.
    expect(addToHistory([], 'D:\\Photos')[0]).toBe('D:\\Photos')
  })
})

describe('removeFromHistory', () => {
  it('removes a matching entry', () => {
    expect(removeFromHistory(['/a', '/b'], '/a')).toEqual(['/b'])
  })

  it('matches case- and separator-insensitively', () => {
    expect(removeFromHistory(['C:\\Photos'], 'c:\\photos\\')).toEqual([])
  })

  it('is a no-op for an unknown folder', () => {
    expect(removeFromHistory(['/a'], '/x')).toEqual(['/a'])
  })
})

describe('sanitizeHistory', () => {
  it('keeps a valid list in order', () => {
    expect(sanitizeHistory(['/a', '/b'])).toEqual(['/a', '/b'])
  })

  it('returns an empty list for anything that is not an array', () => {
    expect(sanitizeHistory(undefined)).toEqual([])
    expect(sanitizeHistory(null)).toEqual([])
    expect(sanitizeHistory('/a')).toEqual([])
    expect(sanitizeHistory({ 0: '/a' })).toEqual([])
  })

  it('drops non-strings and blanks', () => {
    expect(sanitizeHistory(['/a', 42, null, '', '   ', '/b'])).toEqual(['/a', '/b'])
  })

  it('collapses duplicates, keeping the first (most recent) occurrence', () => {
    expect(sanitizeHistory(['/a', '/b', '/A'])).toEqual(['/a', '/b'])
  })

  it('caps the list', () => {
    const many = Array.from({ length: MAX_HISTORY + 5 }, (_, index) => `/p${index}`)
    expect(sanitizeHistory(many)).toHaveLength(MAX_HISTORY)
  })
})

describe('folderName', () => {
  it('returns the last path segment', () => {
    expect(folderName('/photos/trip')).toBe('trip')
    expect(folderName('C:\\Users\\me\\Pictures')).toBe('Pictures')
  })

  it('ignores a trailing separator', () => {
    expect(folderName('/photos/trip/')).toBe('trip')
    expect(folderName('C:\\Photos\\')).toBe('Photos')
  })

  it('falls back to the whole path for a drive root', () => {
    // `C:\` has no segment to show, so showing nothing would be worse.
    expect(folderName('C:\\')).toBe('C:')
    expect(folderName('/')).toBe('/')
  })
})
