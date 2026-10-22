import type { IconProps } from './icons/props.ts'

/** Display options for the branded wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading brand mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the 随身搭子 wordmark.
 * @param props.size - height in px (default 24; width follows the selected artwork).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading brand mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 182 : 156
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 182 24' : '26 0 156 24'}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && (
        <>
          <rect x="0" y="2" width="20" height="20" rx="6" fill="#FF4D2E" />
          <circle cx="6.6" cy="10.5" r="1.1" fill="#fff" />
          <circle cx="13.4" cy="10.5" r="1.1" fill="#fff" />
          <path d="M6.4 13.4c2.2 1.9 5.0 1.9 7.2 0" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      <text x="28" y="17" fill="currentColor" fontFamily="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif" fontSize="14" fontWeight="700" letterSpacing="0.5">随身搭子</text>
      <text x="100" y="16.2" fill="currentColor" opacity="0.55" fontFamily="-apple-system, BlinkMacSystemFont, sans-serif" fontSize="5.5" fontWeight="600" letterSpacing="1.2">PAINUO</text>
    </svg>
  )
}
