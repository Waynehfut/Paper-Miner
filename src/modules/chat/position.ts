/**
 * Pure viewport maths for the selection-translation popover. Kept free of DOM
 * objects (plain rectangles) so it can be unit-tested.
 */

export interface Point {
  left: number;
  top: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Place a popover next to an anchor rect, preferring below it, then above it,
 * and clamping to the viewport with `margin` pixels of breathing room.
 */
export function computePopoverPosition(
  anchor: AnchorRect,
  size: Size,
  viewport: ViewportSize,
  options: { gap?: number; margin?: number; preferred?: Point } = {},
): Point {
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const maxTop = Math.max(margin, viewport.height - height - margin);

  if (options.preferred) {
    return {
      left: clamp(options.preferred.left, margin, maxLeft),
      top: clamp(options.preferred.top, margin, maxTop),
    };
  }

  const below = anchor.bottom + gap;
  const above = anchor.top - height - gap;
  const top = below + height <= viewport.height - margin ? below : above;
  const centered = (anchor.left + anchor.right) / 2 - width / 2;
  return {
    left: clamp(centered, margin, maxLeft),
    top: clamp(top, margin, maxTop),
  };
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** Drag offset helper: keeps moving a point inside the viewport. */
export function movePoint(
  start: Point,
  delta: { dx: number; dy: number },
  size: Size,
  viewport: ViewportSize,
  margin = 8,
): Point {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin);
  const maxTop = Math.max(margin, viewport.height - size.height - margin);
  return {
    left: clamp(start.left + delta.dx, margin, maxLeft),
    top: clamp(start.top + delta.dy, margin, maxTop),
  };
}
