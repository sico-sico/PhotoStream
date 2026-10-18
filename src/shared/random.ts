/**
 * Random show: geometry and sampling.
 *
 * A "word cloud" of thumbnails around one large photo. The interesting part is
 * the placement: the small photos must not overlap each other or the centre, and
 * must stay inside the window. Keeping this pure means the layout can be tested
 * against real geometry instead of by looking at a screenshot.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface ScatterItem {
  id: string
  /** Width / height of the photo, so a portrait stays portrait when scattered. */
  aspect: number
}

export interface ScatterBox extends Box {
  id: string
  /**
   * Resting rotation in degrees, roughly +/-4.
   *
   * Photos pinned perfectly level read as a grid; a slight tilt is what makes
   * them look hand-placed and floating. Small on purpose: anything past about 6
   * degrees makes the subject look crooked rather than casual.
   */
  rotate: number
  /**
   * Apparent distance, 0 (far) to 1 (near).
   *
   * Drives scale, opacity and shadow together, so a photo further back really
   * looks further back instead of just being smaller. It also feeds the 3D
   * transform: a photo at depth 0 sits slightly further from the viewer and is
   * turned away from the centre, which is what produces parallax when the group
   * moves.
   */
  depth: number
  /**
   * Resting tilt about the horizontal axis, in degrees, roughly +/-7.
   *
   * This is the 3D part: the top or bottom edge leans towards or away from the
   * viewer. Combined with the window's `perspective`, the far edge is visibly
   * shorter than the near one, which is the single strongest cue that the photo
   * is a physical object hanging in space rather than a rectangle on a page.
   */
  tiltX: number
  /**
   * Resting turn about the vertical axis, in degrees, roughly +/-9.
   *
   * Larger than the in-plane rotation on purpose. A photo that is merely rotated
   * looks like a tilted sticker; one that is turned towards the viewer is read as
   * an object with a facing direction, especially with the specular sweep.
   */
  tiltY: number
  /** Seconds for one float cycle, so neighbours never bob in lockstep. */
  floatSeconds: number
  /** Seconds before this photo starts floating, so a batch does not pulse. */
  floatDelay: number
}

/**
 * Seeded PRNG, so a scatter can be reproduced exactly.
 *
 * `mulberry32`: 32-bit state, good enough distribution for picking photos, and
 * small enough to read. Determinism matters for tests — a layout assertion that
 * only holds for some random seeds is worse than no assertion.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Sample up to `count` distinct items, skipping any whose key is in `exclude`.
 *
 * Partial Fisher-Yates over a copy: the caller's array is not mutated, and the
 * cost is `count` swaps rather than a full shuffle.
 *
 * @param keyOf identifies an item for `exclude`; defaults to the item itself,
 *   which is what callers working with plain ids want
 */
export function pickRandom<T>(
  pool: readonly T[],
  count: number,
  rng: () => number,
  exclude: ReadonlySet<string> = new Set(),
  keyOf: (item: T) => string = (item) => String(item)
): T[] {
  const available = exclude.size > 0 ? pool.filter((item) => !exclude.has(keyOf(item))) : [...pool]
  const wanted = Math.min(count, available.length)
  const picked: T[] = []
  for (let i = 0; i < wanted; i += 1) {
    const j = i + Math.floor(rng() * (available.length - i))
    const swap = available[i]
    available[i] = available[j]
    available[j] = swap
    picked.push(available[i])
  }
  return picked
}

/**
 * The centred photo's box: contained within `fraction` of the window, centred.
 *
 * Contain rather than cover, so the whole photo is visible; a portrait photo is
 * limited by the window height, a panorama by its width.
 */
export function centreBoxFor(
  aspect: number,
  viewport: { width: number; height: number },
  fraction = 0.5
): Box {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const maxW = Math.max(1, viewport.width * fraction)
  const maxH = Math.max(1, viewport.height * fraction)

  // Contain: shrink until both sides fit.
  let w = maxW
  let h = w / safeAspect
  if (h > maxH) {
    h = maxH
    w = h * safeAspect
  }
  return {
    x: (viewport.width - w) / 2,
    y: (viewport.height - h) / 2,
    w,
    h
  }
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  )
}

/** Area shared by two boxes, in square pixels; 0 when they do not overlap. */
function intersectionArea(a: Box, b: Box): number {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return dx > 0 && dy > 0 ? dx * dy : 0
}

/**
 * Total area of `target` covered by any of `others`, as a fraction of its own.
 *
 * Accumulated rather than per-pair: a photo may be clipped 20% by one neighbour
 * and 20% by another, and it is the sum the eye sees. Checking pair by pair
 * would let a photo be a quarter hidden by each of four neighbours and still
 * pass.
 *
 * Overlapping regions are counted once per neighbour, so the total can exceed 1;
 * that is fine, since anything above the limit fails either way.
 */
function coveredFraction(target: Box, others: readonly Box[]): number {
  const area = target.w * target.h
  if (!(area > 0)) return 0
  const covered = others.reduce((sum, other) => sum + intersectionArea(target, other), 0)
  return covered / area
}

/**
 * Place small photos around the centre photo.
 *
 * Each candidate gets a size drawn from `[minScale, maxScale]` of the window's
 * shorter side, then `attempts` random positions are tried before giving up on
 * it. Sizes vary so the result reads like a cloud rather than a grid; the area is
 * `size²` whatever the aspect, so a portrait and a landscape of the same size
 * carry the same visual weight.
 *
 * Giving up is expected and fine: a window only has room for so many. Returning
 * fewer boxes than candidates is the normal case.
 */
export function scatterAround(input: {
  candidates: readonly ScatterItem[]
  viewport: { width: number; height: number }
  /** Area the small photos must stay out of. */
  centre: Box
  minScale?: number
  maxScale?: number
  /** Margin between photos, in pixels. Negative values allow overlap. */
  gap?: number
  /** Random positions tried per candidate before it is skipped. */
  attempts?: number
  /** Keeps a photo fully inside the window. */
  edge?: number
  /**
   * How much of a photo may be hidden by an already-placed one, 0..1.
   *
   * 0 means "never overlap", which is what an earlier version enforced and what
   * made the screen feel like a tidy grid. A little overlap is what makes photos
   * read as stacked objects in space rather than as cells in a layout: the top
   * photo is nearer, and its shadow falls on the one behind it.
   */
  maxOverlap?: number
  rng: () => number
}): ScatterBox[] {
  const {
    candidates,
    viewport,
    centre,
    // Smaller than before, and with a narrower spread: a dense screen of
    // medium-sized photos reads as a crowd, while a few large ones read as a
    // slideshow. The lower bound still keeps a photo recognisable — below about
    // 6% of the shorter side a face is no longer identifiable.
    minScale = 0.055,
    maxScale = 0.15,
    // Tighter gap: with more photos on screen the same margin costs a lot of
    // them, and at these sizes 6px still reads as separation.
    gap = 6,
    // More attempts because the screen fills up: late candidates are competing
    // for the few remaining gaps, and giving up after 24 tries left the corners
    // empty.
    attempts = 64,
    edge = 6,
    // A quarter of the smaller dimension may be covered. Enough that photos
    // touch and stack like prints on a table; not so much that a face
    // disappears behind its neighbour.
    maxOverlap = 0.25,
    rng
  } = input

  const shorter = Math.min(viewport.width, viewport.height)
  if (!(shorter > 0) || candidates.length === 0) return []

  const placed: ScatterBox[] = []
  for (const candidate of candidates) {
    const aspect = Number.isFinite(candidate.aspect) && candidate.aspect > 0 ? candidate.aspect : 1
    const size = shorter * (minScale + rng() * (maxScale - minScale))
    // Drawn once, before the placement loop, so a candidate that needs several
    // attempts keeps the same apparent distance instead of flickering between
    // depths while it looks for a gap.
    const depth = rng()
    // w*h = size^2 and w/h = aspect, so the visual weight does not depend on
    // whether the photo is tall or wide.
    const root = Math.sqrt(aspect)
    const w = size * root
    const h = size / root
    if (w > viewport.width - edge * 2 || h > viewport.height - edge * 2) continue

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const box: ScatterBox = {
        id: candidate.id,
        x: edge + rng() * (viewport.width - w - edge * 2),
        y: edge + rng() * (viewport.height - h - edge * 2),
        w,
        h,
        // +/-4 degrees, and avoid the dead-flat centre: a rotation that happens
        // to land on 0 would look like a mistake next to its tilted neighbours.
        rotate: (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 3.2),
        depth,
        // Signed, so the screen does not lean as a whole. The magnitude grows
        // with distance because a fanned-out group exaggerates the far photos:
        // near ones face the viewer, distant ones are turned away.
        tiltX: (rng() < 0.5 ? -1 : 1) * (2 + rng() * 5) * (0.45 + (1 - depth) * 0.9),
        tiltY: (rng() < 0.5 ? -1 : 1) * (2.5 + rng() * 6.5) * (0.45 + (1 - depth) * 0.9),
        floatSeconds: 5.5 + rng() * 4.5,
        floatDelay: -rng() * 8
      }
      // The subject is never covered.
      if (overlaps(box, centre, gap)) continue
      // Bounded overlap in both directions: this photo must not cover more than
      // its share of what is already there (it paints on top), and it must not
      // arrive already buried under the accumulation of its neighbours.
      const coversExisting = placed.some(
        (other) => intersectionArea(box, other) / Math.max(1, other.w * other.h) > maxOverlap
      )
      if (coversExisting) continue
      if (coveredFraction(box, placed) > maxOverlap) continue
      placed.push(box)
      break
    }
  }
  return placed
}
