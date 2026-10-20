import type { LayoutMode, Photo } from './types'

export interface LayoutItem {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutResult {
  items: LayoutItem[]
  width: number
  height: number
}

export interface LayoutOptions {
  mode: LayoutMode
  /** Width the wall is laid out for, in CSS pixels. */
  containerWidth: number
  gap?: number
  /** Target height of a row in `grid` mode. */
  targetRowHeight?: number
  /** Column width in `masonry` mode. */
  columnWidth?: number
  /** Edge length of a cell in `square` mode. */
  cellSize?: number
}

export const LAYOUT_DEFAULTS = {
  gap: 8,
  targetRowHeight: 220,
  columnWidth: 260,
  cellSize: 200
} as const

/**
 * Aspect-ratio clamp, applied to width/height.
 *
 * Guards against divide-by-zero and absurd panoramas from broken metadata (a
 * corrupt EXIF height, a one-pixel-tall stitch). 5:1 is also the widest tile
 * the layouts are designed to show. `thumbs.ts` reuses the same bound to size
 * wall renditions, so the two cannot disagree about the widest tile possible.
 */
export const MIN_DISPLAY_ASPECT = 0.2
export const MAX_DISPLAY_ASPECT = 5

/** Aspect ratio guard: avoids divide-by-zero and absurd panoramas from broken metadata. */
function aspectOf(photo: Photo): number {
  const w = Number(photo.width)
  const h = Number(photo.height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 1
  return Math.min(Math.max(w / h, MIN_DISPLAY_ASPECT), MAX_DISPLAY_ASPECT)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function squareLayout(photos: readonly Photo[], cell: number, gap: number, containerWidth: number): LayoutResult {
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (cell + gap)))
  // Distribute the leftover width across the columns instead of discarding it.
  // `floor` above leaves up to a full cell unused, which showed as a 150-180px
  // empty strip on the right of an otherwise square grid.
  const fitted = (containerWidth - gap * (columns - 1)) / columns
  const cellWidth = fitted > 0 ? round(fitted) : cell

  const items: LayoutItem[] = photos.map((photo, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    return {
      id: photo.id,
      x: round(col * (cellWidth + gap)),
      y: round(row * (cellWidth + gap)),
      w: cellWidth,
      h: cellWidth
    }
  })
  const rows = Math.ceil(photos.length / columns)
  return {
    items,
    width: round(columns * cellWidth + (columns - 1) * gap),
    height: rows === 0 ? 0 : round(rows * cellWidth + (rows - 1) * gap)
  }
}

function masonryLayout(photos: readonly Photo[], columnWidth: number, gap: number, containerWidth: number): LayoutResult {
  const columns = Math.max(1, Math.floor((containerWidth + gap) / (columnWidth + gap)))
  const heights = new Array<number>(columns).fill(0)
  const items: LayoutItem[] = photos.map((photo) => {
    let target = 0
    for (let i = 1; i < columns; i += 1) if (heights[i] < heights[target]) target = i
    const h = round(columnWidth / aspectOf(photo))
    const item: LayoutItem = {
      id: photo.id,
      x: round(target * (columnWidth + gap)),
      y: round(heights[target]),
      w: columnWidth,
      h
    }
    heights[target] = heights[target] + h + gap
    return item
  })
  const tallest = heights.length ? Math.max(...heights) : 0
  return {
    items,
    width: round(columns * columnWidth + (columns - 1) * gap),
    height: round(Math.max(0, tallest - gap))
  }
}

/**
 * Justified rows: each row is scaled so it spans the container exactly, so the
 * wall reads as tidy horizontal bands while every photo keeps its own ratio.
 */
function justifiedLayout(photos: readonly Photo[], targetRowHeight: number, gap: number, containerWidth: number): LayoutResult {
  const items: LayoutItem[] = []
  let row: Photo[] = []
  let rowAspectSum = 0
  let y = 0
  let maxWidth = 0

  const flush = (isLast: boolean): void => {
    if (row.length === 0) return
    const available = containerWidth - gap * (row.length - 1)
    // The final row keeps the target height instead of stretching, so a
    // two-photo tail is not blown up to fill the whole width.
    const scale = isLast ? 1 : available / (targetRowHeight * rowAspectSum)
    const height = round(isLast ? targetRowHeight : targetRowHeight * scale)
    let x = 0
    for (const photo of row) {
      const w = round(height * aspectOf(photo))
      items.push({ id: photo.id, x: round(x), y: round(y), w, h: height })
      x += w + gap
    }
    maxWidth = Math.max(maxWidth, x - gap)
    y += height + gap
    row = []
    rowAspectSum = 0
  }

  for (const photo of photos) {
    row.push(photo)
    rowAspectSum += aspectOf(photo)
    const projected = targetRowHeight * rowAspectSum + gap * (row.length - 1)
    if (projected >= containerWidth) flush(false)
  }
  flush(true)

  return {
    items,
    width: round(maxWidth),
    height: y === 0 ? 0 : round(y - gap)
  }
}

/** Lay photos out along a wall of the given width. Pure: same input, same output. */
export function computeLayout(photos: readonly Photo[], options: LayoutOptions): LayoutResult {
  const gap = options.gap ?? LAYOUT_DEFAULTS.gap
  const containerWidth = Math.max(1, options.containerWidth)
  if (photos.length === 0) return { items: [], width: containerWidth, height: 0 }

  switch (options.mode) {
    case 'square':
      return squareLayout(photos, options.cellSize ?? LAYOUT_DEFAULTS.cellSize, gap, containerWidth)
    case 'masonry':
      return masonryLayout(photos, options.columnWidth ?? LAYOUT_DEFAULTS.columnWidth, gap, containerWidth)
    case 'grid':
    default:
      return justifiedLayout(photos, options.targetRowHeight ?? LAYOUT_DEFAULTS.targetRowHeight, gap, containerWidth)
  }
}

/** Bounding box of a set of items, used for the world size of a filtered subset. */
export function layoutBounds(items: readonly LayoutItem[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const item of items) {
    width = Math.max(width, item.x + item.w)
    height = Math.max(height, item.y + item.h)
  }
  return { width: round(width), height: round(height) }
}
