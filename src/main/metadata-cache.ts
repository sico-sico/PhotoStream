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
      this.pruneStatement = db.prepare('DELETE FROM photo_metadata WHERE path NOT IN (SELECT value FROM json_each(?))')
    } catch {
      // No usable database: the app still works, it just pays the parse cost.
      this.db = null
      this.getStatement = null
      this.putStatement = null
      this.putExifStatement = null
      this.getExifStatement = null
      this.pruneStatement = null
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

  /** Remember a parsed result. Called once per photo per scan. */
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
   * Drop rows for photos that are no longer in the folder.
   *
   * Without this the database grows forever as folders are opened and closed.
   * Runs once per scan, in a single transaction.
   */
  retain(paths: readonly string[]): void {
    if (!this.pruneStatement || paths.length === 0) return
    try {
      this.pruneStatement.run(JSON.stringify(paths))
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
