const VIEWPORT_MARGIN = 8;

/**
 * Clamps a position so an element of the given size stays within the viewport along one axis.
 * Works for both horizontal (left/width) and vertical (top/height) clamping.
 * @param position - The desired position (top or left) in viewport-relative pixels
 * @param elementSize - The element's size along this axis (height or width)
 * @param viewportSize - The viewport size along this axis (innerHeight or innerWidth)
 * @returns The clamped position value
 */
export function clampToViewport(
  position: number,
  elementSize: number,
  viewportSize: number,
): number {
  const min = VIEWPORT_MARGIN;
  const max = viewportSize - elementSize - VIEWPORT_MARGIN;
  return Math.max(min, Math.min(position, max));
}
