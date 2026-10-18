import { protocol, net } from 'electron'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PIC_PHOTO_HOST, PIC_SCHEME, PIC_THUMB_HOST } from '../shared/ipc'

/**
 * `pic://` protocol.
 *
 * The renderer must never receive raw filesystem paths, and `file://` is
 * blocked under `webSecurity`. A custom scheme gives us two things at once:
 * an allow-listed surface (only the current warm directory and the thumb cache
 * can be read) and Chromium's normal image pipeline, including Range requests.
 */
export interface ProtocolRoots {
  /** Directory of the currently open library. */
  photoDir: string
  /** Thumbnail cache directory. */
  thumbDir: string
}

export function registerPicScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PIC_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

/**
 * Build the URL the renderer uses for a cached thumbnail.
 *
 * `relativePath` may contain `/` separators, because the cache is sharded into
 * subdirectories. Each segment is encoded separately: encoding the whole string
 * would turn the separators into `%2F`, which still round-trips through
 * `decodeURIComponent` but produces URLs that browsers and proxies treat as a
 * single opaque segment rather than a path.
 */
export function thumbUrl(relativePath: string): string {
  const encoded = relativePath.split(/[/\\]+/).filter(Boolean).map(encodeURIComponent).join('/')
  return `${PIC_SCHEME}://${PIC_THUMB_HOST}/${encoded}`
}

/** Build the URL the renderer uses for a full-resolution photo. */
export function photoUrl(fileName: string): string {
  return `${PIC_SCHEME}://${PIC_PHOTO_HOST}/${encodeURIComponent(fileName)}`
}

/**
 * Reject any resolved path that escapes its root, so a crafted URL such as
 * `pic://photo/../../secret` cannot read outside the library.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const normalisedRoot = resolve(root) + sep
  const normalised = resolve(candidate)
  return normalised.toLowerCase().startsWith(normalisedRoot.toLowerCase())
}

/**
 * Resolve a `pic://` request to a file path, or `null` when it is not allowed.
 * Exported for tests: this is the security boundary of the protocol.
 */
export function resolvePicRequest(url: string, roots: ProtocolRoots): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PIC_SCHEME}:`) return null

  // Decode each segment separately, mirroring `thumbUrl`. A single
  // `decodeURIComponent` over the whole pathname would turn an encoded `%2F`
  // into a real separator *after* the path was split, which is exactly the kind
  // of ambiguity a traversal guard must not have.
  let name: string
  try {
    name = parsed.pathname
      .replace(/^\/+/, '')
      .split('/')
      .map(decodeURIComponent)
      .join('/')
  } catch {
    // Malformed percent-encoding.
    return null
  }
  if (!name || name.includes('\0')) return null

  const root = parsed.host === PIC_THUMB_HOST ? roots.thumbDir : parsed.host === PIC_PHOTO_HOST ? roots.photoDir : null
  if (!root) return null

  const candidate = resolve(root, name)
  if (!isInsideRoot(root, candidate)) return null
  return existsSync(candidate) ? candidate : null
}

export function handlePicProtocol(getRoots: () => ProtocolRoots): void {
  protocol.handle(PIC_SCHEME, (request) => {
    const file = resolvePicRequest(request.url, getRoots())
    if (!file) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}
