import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link FISH_LOGO_PATH} (width and height in user units). */
export const FISH_LOGO_VIEWBOX = { width: 23.16, height: 17.04 }

/** The 随身搭子 rounded mark, exported for consumers that compose their own svg around the same geometry. */
export const FISH_LOGO_PATH = 'M5 0H18.16C20.9 0 23.16 2.26 23.16 5V12.04C23.16 14.78 20.9 17.04 18.16 17.04H5C2.26 17.04 0 14.78 0 12.04V5C0 2.26 2.26 0 5 0Z'

/**
 * Render the brand mark.
 * @param props.size - width in px (default 24; height keeps the 23.16:17.04 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={FISH_LOGO_PATH} fill="currentColor" />
    </svg>
  )
}
