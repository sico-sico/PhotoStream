/**
 * Recently opened folders.
 *
 * Kept as pure functions over a plain string array so the ordering, de-dupe and
 * capping rules can be unit-tested without touching the settings file.
 *
 * Two invariants matter for the UI:
 * - most recent first, so the list reads as a history;
 * - no duplicates, so re-opening a folder moves it to the top instead of adding
 *   a second identical row.
 */

/**
 * How many folders to remember.
 *
 * Long enough to cover a working session's worth of libraries, short enough
 * that the dropdown stays a list rather than a scroll area. The whole list is
 * rewritten on every open, so an unbounded array would grow forever.
 */
export const MAX_HISTORY = 12

/**
 * Comparison key for a folder path.
 *
 * Windows paths are case-insensitive, and the same folder can arrive with or
 * without a trailing separator depending on the source (the dialog, a drop, or
 * a hand-edited settings file), so both are normalised away. The original
 * string is what gets stored and displayed.
 */
export function historyKey(dir: string): string {
  return dir.trim().replace(/[/\\]+$/, '').toLowerCase()
}

/** Move `dir` to the front, dropping any earlier occurrence, capped at `limit`. */
export function addToHistory(history: readonly string[], dir: string, limit = MAX_HISTORY): string[] {
  const value = dir.trim()
  if (!value) return [...history].slice(0, limit)
  const key = historyKey(value)
  const rest = history.filter((entry) => historyKey(entry) !== key)
  return [value, ...rest].slice(0, Math.max(0, limit))
}

/** Drop one folder, matching case- and separator-insensitively. */
export function removeFromHistory(history: readonly string[], dir: string): string[] {
  const key = historyKey(dir)
  return history.filter((entry) => historyKey(entry) !== key)
}

/**
 * Validate a value read from disk.
 *
 * A settings file is user-editable and may predate this feature, so anything
 * that is not an array of non-empty strings is discarded rather than trusted.
 * Duplicates are collapsed in favour of the first (most recent) occurrence.
 */
export function sanitizeHistory(raw: unknown, limit = MAX_HISTORY): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const value = entry.trim()
    if (!value) continue
    const key = historyKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}

/** The label for a folder: its last path segment, or the path itself at a root. */
export function folderName(dir: string): string {
  const trimmed = dir.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  const last = parts[parts.length - 1] ?? ''
  return last || trimmed || dir
}
