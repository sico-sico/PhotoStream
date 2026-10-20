/**
 * Persistent cache of parsed photo metadata.
 *
 * Measured on the 3226-photo sample library, opening a folder spent 1178 ms of
 * 1296 ms reading EXIF: every photo had its first 512 KB read to find the
 * capture date (1.6 GB in total). The parse itself is unavoidable the first
 * time, but the answer only changes when the file does, so it is cached here.
 *
 * `node:sqlite` is used rather than a small JSON file:
 * - 3226 keyed lookups take ~6 ms against ~422 ms of re-reading, and a JSON
 *   cache would have to be read, parsed and rewritten in full on every save;
 * - the SQLite file survives a crash mid-write, which a rewritten JSON blob does
 *   not;
 * - the module ships with Node/Electron, so this adds no dependency.
 *
 * The cache is keyed by path AND `mtime` AND size. A photo edited or re-exported
 * in Lightroom keeps its path but changes both, so a stale row can never be
 * mistaken for a fresh one.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RawExif } from '../shared/exif'

export interface CachedMetadata {
  width: number
  height: number
  takenAt: string
  orientation: number
}

interface MetadataRow {
  width: number
  height: number
  taken_at: string
  orientation: number
  full_exif: string | null
}

/** A stored row, as the wall needs it: enough to build a tile without the file. */
export interface CachedPhotoRow {
  path: string
  mtimeMs: number
  sizeBytes: number
  width: number
  height: number
  takenAt: string
  orientation: number
}

/** Shape of the `list` query, before the columns are renamed. */
interface ListRow {
  path: string
  mtime_ms: number
  size_bytes: number
  width: number
  height: number
  taken_at: string
  orientation: number
}

/**
 * Point lookups against one folder, taken from a single query.
 *
 * A 40 000-photo scan issues 40 000 lookups, and each prepared-statement round
 * trip costs ~8 µs even on a miss — 313 ms of pure overhead. Reading the whole
 * subtree once (154 ms) and answering from a `Map` (13 ms to build) removes
 * most of it, and removes the per-file SQLite call from the scan's hot path
 * entirely.
 */
export interface CachedIndex {
  /** Cached metadata for this exact file version, or `undefined` on a miss. */
  get(path: string, mtimeMs: number, sizeBytes: number): CachedMetadata | undefined
}

/**
 * A folder's cached rows, as both the pre-scan snapshot and the scan need them.
 *
 * `rows` is what the wall can paint before the disk is touched; `get` is what
 * the scan asks per file. Reading the range once serves both, where a seed query
 * plus a lookup query would read 40 000 rows twice (~150 ms each).
 */
export interface CacheSnapshot extends CachedIndex {
  readonly rows: readonly CachedPhotoRow[]
}

/** One row to write: the file version plus what was parsed from it. */
export interface CacheWrite extends CachedMetadata {
  path: string
  mtimeMs: number
  sizeBytes: number
}

/**
 * Bumped when the stored shape changes; old rows are then dropped.
 *
 * v2 added `full_exif`. Dropping is cheaper than migrating: every value is
 * derived from the photos and is re-read on demand.
 */
const SCHEMA_VERSION = 2

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS photo_metadata (
    path        TEXT    PRIMARY KEY,
    mtime_ms    REAL    NOT NULL,
    size_bytes  INTEGER NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    taken_at    TEXT    NOT NULL,
    orientation INTEGER NOT NULL,
    -- Full EXIF as JSON, filled the first time the detail panel is opened.
    -- NULL means "not read yet", which is different from "the file has none".
    full_exif   TEXT
  );
  CREATE TABLE IF NOT EXISTS cache_info (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

/**
 * Escape a literal for use as a SQL `LIKE` prefix, using `!` as the escape.
 *
 * `%` and `_` are wildcards, so a folder whose name contains them would widen
 * the match to unrelated paths. `!` is used instead of the default `\\` because
 * that character is also a Windows path separator.
 */
function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (character) => `!${character}`)
}

/**
 * A metadata store backed by a single SQLite file.
 *
 * Every method is defensive: a cache is an optimisation, so a corrupt or
 * unreadable database must degrade to "no cache" rather than stop the app from
 * opening a folder. Failures are therefore swallowed and reported as misses.
 */
export class MetadataCache {
  private readonly db: DatabaseSync | null
  private readonly getStatement
  private readonly putStatement
  private readonly putExifStatement
  private readonly getExifStatement
  private readonly pruneStatement
  private readonly listStatement

  constructor(filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const db = new DatabaseSync(filePath)
      // WAL keeps readers from blocking on the periodic prune, and NORMAL sync
      // is safe here: losing the last few rows only costs a re-read.
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      db.exec(SCHEMA)

      const stored = db.prepare('SELECT value FROM cache_info WHERE key = ?').get('schema_version')
      if (stored && Number(stored.value) !== SCHEMA_VERSION) {
        // An incompatible layout is cheaper to rebuild than to migrate: the data
        // is all derived from the photos.
        db.exec('DROP TABLE photo_metadata')
        db.exec(SCHEMA)
      }
      db.prepare('INSERT OR REPLACE INTO cache_info (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(SCHEMA_VERSION)
      )

      /*
       * One-time repair of rows written before the 64 KB-window bug was fixed.
       *
       * Those rows hold `width = height = 0` for any photo whose APP segments add
       * up to more than the first read window, because the scan returned as soon
       * as it had a date. The wall then laid the photo out as a square. Deleting
       * them costs one re-read per affected photo and nothing for the rest, which
       * a schema bump — dropping all 40 000 rows — would not.
       */
      const repaired = db.prepare('SELECT value FROM cache_info WHERE key = ?').get('zero_dimension_repair')
      if (!repaired) {
        db.exec('DELETE FROM photo_metadata WHERE width <= 0 OR height <= 0')
        db.prepare('INSERT OR REPLACE INTO cache_info (key, value) VALUES (?, ?)').run(
          'zero_dimension_repair',
          '1'
        )
      }

      this.db = db
      this.getStatement = db.prepare(
        'SELECT width, height, taken_at, orientation, full_exif FROM photo_metadata WHERE path = ? AND mtime_ms = ? AND size_bytes = ?'
      )
      this.putStatement = db.prepare(
        'INSERT OR REPLACE INTO photo_metadata (path, mtime_ms, size_bytes, width, height, taken_at, orientation, full_exif) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      this.putExifStatement = db.prepare(
        'UPDATE photo_metadata SET full_exif = ? WHERE path = ? AND mtime_ms = ? AND size_bytes = ?'
      )
      this.getExifStatement = db.prepare(
        'SELECT full_exif FROM photo_metadata WHERE path = ? AND mtime_ms = ? AND size_bytes = ?'
      )
      this.pruneStatement = db.prepare(
        // Scoped to one folder: an unscoped delete wiped every *other* folder's
        // rows, which made the history menu pointless — measured at 1387 ms to
        // reopen a 3226-photo library instead of 104 ms.
        //
        // Two prefixes, one per separator: the database holds Windows paths
        // (`D:\Photos\a.jpg`) while tests and any future portability work use
        // `/`. `!` is the escape character rather than `\`, which is both a
        // path separator on Windows and SQL's default escape.
        `DELETE FROM photo_metadata
           WHERE (path LIKE ? ESCAPE '!' OR path LIKE ? ESCAPE '!')
             AND path NOT IN (SELECT value FROM json_each(?))`
      )
      // A range scan rather than `LIKE`: the primary key is the path, and SQLite
      // can only use it for a range (its default `LIKE` is case-insensitive,
      // which the index cannot answer). Two ranges, one per separator.
      this.listStatement = db.prepare(
        `SELECT path, mtime_ms, size_bytes, width, height, taken_at, orientation
           FROM photo_metadata
          WHERE path >= ? AND path < ?`
      )
    } catch {
      // No usable database: the app still works, it just pays the parse cost.
      this.db = null
      this.getStatement = null
      this.putStatement = null
      this.putExifStatement = null
      this.getExifStatement = null
      this.pruneStatement = null
      this.listStatement = null
    }
  }

  /** Cached metadata for this exact file version, or `undefined` on a miss. */
  lookup(path: string, mtimeMs: number, sizeBytes: number): CachedMetadata | undefined {
    if (!this.getStatement) return undefined
    try {
      const row = this.getStatement.get(path, mtimeMs, sizeBytes) as MetadataRow | undefined
      if (!row) return undefined
      return {
        width: Number(row.width),
        height: Number(row.height),
        takenAt: String(row.taken_at),
        orientation: Number(row.orientation)
      }
    } catch {
      return undefined
    }
  }

  /**
   * Remember a parsed result. Called once per photo per scan.
   *
   * Single rows only: a scan writes through `storeMany`, because 40 000
   * autocommitted inserts cost 2171 ms against 104 ms in one transaction.
   */
  store(path: string, mtimeMs: number, sizeBytes: number, meta: CachedMetadata): void {
    if (!this.putStatement) return
    try {
      // `full_exif` is left NULL: the scan does not read it, and NULL means
      // "not read yet" rather than "this photo has none".
      this.putStatement.run(path, mtimeMs, sizeBytes, meta.width, meta.height, meta.takenAt, meta.orientation, null)
    } catch {
      // A failed write only costs a re-read next time.
    }
  }

  /**
   * Remember many parsed results in one transaction.
   *
   * This is the scan's write path. Without a transaction SQLite commits per
   * row, which on a 40 000-photo library took 2171 ms — more than half of what
   * the cold scan spent on I/O, because each commit has to wait for the disk
   * behind the concurrent photo reads.
   */
  storeMany(rows: readonly CacheWrite[]): void {
    if (!this.putStatement || this.db === null || rows.length === 0) return
    try {
      this.db.exec('BEGIN')
      try {
        for (const row of rows) {
          this.putStatement.run(
            row.path,
            row.mtimeMs,
            row.sizeBytes,
            row.width,
            row.height,
            row.takenAt,
            row.orientation,
            null
          )
        }
        this.db.exec('COMMIT')
      } catch (error) {
        // A partial transaction is worse than none: roll back and let the next
        // scan pay for the parse again.
        this.db.exec('ROLLBACK')
        throw error
      }
    } catch {
      // A failed write only costs a re-read next time.
    }
  }

  /**
   * Full EXIF for this exact file version, or `undefined` if it was never read.
   *
   * Distinguishing "never read" from "no EXIF" matters: the panel must know
   * whether to parse the file or to show what it already has.
   */
  lookupExif(path: string, mtimeMs: number, sizeBytes: number): RawExif | undefined {
    if (!this.getExifStatement) return undefined
    try {
      const row = this.getExifStatement.get(path, mtimeMs, sizeBytes) as { full_exif: string | null } | undefined
      if (!row || row.full_exif === null) return undefined
      return JSON.parse(row.full_exif) as RawExif
    } catch {
      // A corrupt JSON blob is treated as "not cached".
      return undefined
    }
  }

  /**
   * Store the full EXIF after the detail panel has read it.
   *
   * Only update an existing row: if the photo is not in the cache the scan never
   * ran for it, and inserting a partial row here would lose the fields the scan
   * depends on.
   */
  storeExif(path: string, mtimeMs: number, sizeBytes: number, exif: RawExif): void {
    if (!this.putExifStatement) return
    try {
      this.putExifStatement.run(JSON.stringify(exif), path, mtimeMs, sizeBytes)
    } catch {
      // Best effort: the panel already got its answer.
    }
  }

  /**
   * Every cached photo under `dir`, without touching the filesystem.
   *
   * Used to paint the wall from what was learned last time, while the scan
   * re-reads the folder to confirm it. The rows are only *reported*, not
   * trusted: the scan that follows replaces them, and `retain` deletes the rows
   * of files that are gone.
   *
   * Returns an empty array when the cache is unusable, which simply means the
   * wall waits for the scan as it always did.
   */
  list(dir: string): CachedPhotoRow[] {
    if (!this.listStatement) return []
    const base = dir.replace(/[\\/]+$/, '')
    if (!base) return []
    try {
      const rows: CachedPhotoRow[] = []
      for (const separator of ['\\', '/']) {
        const start = `${base}${separator}`
        // `\uffff` sorts after every path character in UTF-8 byte order, so the
        // upper bound covers the whole subtree without matching a sibling such
        // as `D:\Photos2\a.jpg` (the separator is part of the prefix).
        const end = `${start}\uffff`
        for (const row of this.listStatement.all(start, end) as unknown as ListRow[]) {
          rows.push({
            path: String(row.path),
            mtimeMs: Number(row.mtime_ms),
            sizeBytes: Number(row.size_bytes),
            width: Number(row.width),
            height: Number(row.height),
            takenAt: String(row.taken_at),
            orientation: Number(row.orientation)
          })
        }
      }
      return rows
    } catch {
      return []
    }
  }

  /**
   * The same rows as `list`, keyed for the scan's point lookups.
   *
   * Building this costs one query plus a `Map`; answering 40 000 lookups from it
   * costs nothing, against ~8 µs each for a prepared statement. A scan calls this
   * once, so the read is not repeated per photo.
   */
  snapshot(dir: string): CacheSnapshot {
    const rows = this.list(dir)
    const index = new Map<string, CachedPhotoRow>()
    for (const row of rows) index.set(row.path, row)
    return {
      rows,
      get(path, mtimeMs, sizeBytes) {
        const row = index.get(path)
        // The row is only usable for the exact file version it was read from.
        if (!row || row.mtimeMs !== mtimeMs || row.sizeBytes !== sizeBytes) return undefined
        return {
          width: row.width,
          height: row.height,
          takenAt: row.takenAt,
          orientation: row.orientation
        }
      }
    }
  }

  /**
   * Drop rows for photos that are gone from `dir`.
   *
   * Only rows under `dir` are considered. The cache is shared by every folder
   * the user has ever opened, so an unscoped prune deleted the other libraries'
   * rows the moment a different folder was scanned — the history menu would
   * then re-read everything it was meant to remember.
   *
   * Runs once per scan, in a single transaction.
   *
   * @param dir the folder that was just scanned
   * @param paths absolute paths of the photos still in it
   */
  retain(dir: string, paths: readonly string[]): void {
    if (!this.pruneStatement || paths.length === 0) return
    try {
      const base = escapeLike(dir)
      this.pruneStatement.run(`${base}/%`, `${base}\\%`, JSON.stringify(paths))
    } catch {
      // Pruning is housekeeping; skipping it on failure is harmless.
    }
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      // Already closed, or the handle was never usable.
    }
  }
}
