/**
 * Inline stroke icons. Deliberately minimal: 16px grid, currentColor, no icon
 * font, no external asset. Decorative by default (`aria-hidden`), so callers add
 * their own accessible label where an icon carries meaning.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.8 1.6 13.2h12.8L8 1.8Z" />
    <path d="M8 6.2v3.1" />
    <path d="M8 11.6h.01" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.3" />
    <path d="M8 7.3v3.6" />
    <path d="M8 5.2h.01" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.9 8.4 6.3 11.8 13.1 4.6" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.6" />
    <path d="M10.4 10.4 14 14" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9" />
    <path d="M13.6 2.4v3.4h-3.4" />
  </Svg>
);

export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 1.4 3.2 9.1h3.6L7 14.6 12.8 6.9H9.2L9 1.4Z" />
  </Svg>
);

export const IconNetwork = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="3" r="1.9" />
    <circle cx="3" cy="12.4" r="1.9" />
    <circle cx="13" cy="12.4" r="1.9" />
    <path d="M7.1 4.7 3.8 10.7M8.9 4.7l3.3 6M4.9 12.4h6.2" />
  </Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 8h10.2M9.3 4.6 12.8 8l-3.5 3.4" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.4 10.6 8 6 12.6" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 6 8 10.6 12.6 6" />
  </Svg>
);

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="5.3" r="2.7" />
    <path d="M2.9 13.6c0-2.6 2.3-4.3 5.1-4.3s5.1 1.7 5.1 4.3" />
  </Svg>
);

export const IconDoc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.9h5l3 3v9.2H4V1.9Z" />
    <path d="M9 1.9v3h3" />
    <path d="M5.9 8.4h4.2M5.9 10.8h4.2" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.3" />
    <path d="M8 4.6V8l2.6 1.6" />
  </Svg>
);

export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.4 8a5.6 5.6 0 1 0 1.7-4" />
    <path d="M2.2 1.9v3.3h3.3" />
    <path d="M8 5v3.3l2.4 1.4" />
  </Svg>
);

export const IconTarget = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <circle cx="8" cy="8" r="2.6" />
    <circle cx="8" cy="8" r="0.4" />
  </Svg>
);

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.6 9.4a2.9 2.9 0 0 0 4.1 0l1.9-1.9a2.9 2.9 0 0 0-4.1-4.1l-1 1" />
    <path d="M9.4 6.6a2.9 2.9 0 0 0-4.1 0L3.4 8.5a2.9 2.9 0 0 0 4.1 4.1l1-1" />
  </Svg>
);

export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.8 14.2 5 8 8.2 1.8 5 8 1.8Z" />
    <path d="m2.6 8.1 5.4 2.8 5.4-2.8" />
    <path d="m2.6 11 5.4 2.8L13.4 11" />
  </Svg>
);

export const IconZoomIn = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.6" />
    <path d="M10.4 10.4 14 14M7 5.2v3.6M5.2 7h3.6" />
  </Svg>
);

export const IconZoomOut = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.6" />
    <path d="M10.4 10.4 14 14M5.2 7h3.6" />
  </Svg>
);

export const IconFit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.4 5.6V2.4h3.2M13.6 5.6V2.4h-3.2M2.4 10.4v3.2h3.2M13.6 10.4v3.2h-3.2" />
  </Svg>
);

export const IconSpark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.6v4M8 10.4v4M1.6 8h4M10.4 8h4" />
    <path d="m3.8 3.8 2.2 2.2M10 10l2.2 2.2M12.2 3.8 10 6M6 10l-2.2 2.2" />
  </Svg>
);
