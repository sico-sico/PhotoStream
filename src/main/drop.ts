import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isSupportedImage } from './scanner'

/**
 * Where an incoming path should take the user.
 *
 * `photo` is set when the path named a single image rather than a folder. The
 * wall then opens that image's folder *and* focuses the image, which is what
 * both entry points mean:
 * - dropping one photo on the window, and
 * - "Open with → PhotoStream" from Explorer, which passes the file as argv.
 */
export interface OpenTarget {
  /** Directory to browse. */
  dir: string
  /** Absolute path of the photo to focus, or `''` when a whole folder was given. */
  photo: string
}

/**
 * Resolve a path the app was asked to open.
 *
 * Rules, in order:
 * - a directory opens as itself, with nothing focused;
 * - a supported image opens the directory that contains it and focuses it;
 * - anything else is rejected.
 *
 * Rejection is deliberately loud rather than silent: a dropped `.txt` that did
 * nothing at all would look like a broken drag-and-drop, so the caller shows the
 * same error banner a failed scan uses.
 *
 * Lives outside `ipc.ts` so it can be unit-tested without an Electron runtime.
 */
export async function resolveOpenTarget(target: string): Promise<OpenTarget> {
  const cleaned = target.trim()
  if (!cleaned) throw new Error('Nothing was dropped.')

  const absolute = resolve(cleaned)

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absolute)
  } catch {
    throw new Error(`Cannot open "${absolute}": the path no longer exists.`)
  }

  if (info.isDirectory()) return { dir: absolute, photo: '' }
  if (info.isFile() && isSupportedImage(absolute)) return { dir: dirname(absolute), photo: absolute }

  throw new Error(`"${absolute}" is not a folder of photos, or a JPEG/PNG file.`)
}

/**
 * Backwards-compatible wrapper returning just the directory.
 *
 * Kept so callers that only need the folder do not have to destructure, and so
 * the existing tests keep documenting the folder-only contract.
 */
export async function resolveDropTarget(target: string): Promise<string> {
  return (await resolveOpenTarget(target)).dir
}

/**
 * Pick the photo to open out of a process command line.
 *
 * Windows passes one argument per path, already de-quoted. Electron adds its own
 * flags (`--allow-file-access-from-files`, `--user-data-dir=...`, and in
 * development the script path), so anything starting with `-` is ignored, as is
 * any argument that is not a supported image.
 *
 * Only the first candidate is used: "Open with" hands over one file, and several
 * files have no single sensible meaning for a wall that shows one folder.
 *
 * @param argv the full `process.argv`
 */
export function photoFromArgv(argv: readonly string[]): string {
  // One pass over everything after argv[0] covers both builds: in a packaged app
  // argv[1] is the first real argument, and in development it is the entry
  // script — which fails the `.js` and image checks either way, so the loop does
  // not need to know which build it is in.
  for (const argument of argv.slice(1)) {
    if (!argument || argument.startsWith('-')) continue
    if (!isSupportedImage(argument)) continue
    return argument
  }
  return ''
}
