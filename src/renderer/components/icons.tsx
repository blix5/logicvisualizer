// Toolbar icons: inline SVG, 16px, drawn with currentColor so buttons can tint
// them. Kept here rather than pulled from an icon package; there are only a few.
import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ReloadIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.46-3.54" />
    <path d="M13 2.5V5h-2.5" />
  </Icon>
);

/** A note with an upward arrow: import or replace the bounce. */
export const MusicUploadIcon = () => (
  <Icon>
    <path d="M6 12.5V4l6-1.5v7" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="10.5" cy="9.5" r="1.5" />
    <path d="M13.5 15v-3.5M12 13l1.5-1.5L15 13" />
  </Icon>
);

export const PlayIcon = () => (
  <Icon>
    <path d="M5 3.2v9.6L12.5 8z" fill="currentColor" stroke="none" />
  </Icon>
);

export const PauseIcon = () => (
  <Icon>
    <rect x="4" y="3.5" width="2.6" height="9" rx="0.6" fill="currentColor" stroke="none" />
    <rect x="9.4" y="3.5" width="2.6" height="9" rx="0.6" fill="currentColor" stroke="none" />
  </Icon>
);

export const ToStartIcon = () => (
  <Icon>
    <path d="M4 3.5v9" />
    <path d="M12.5 3.5v9L6 8z" fill="currentColor" stroke="none" />
  </Icon>
);

/** Stacked lanes of regions: the arrange view. */
export const ArrangeIcon = () => (
  <Icon>
    <rect x="1.75" y="3" width="7" height="3" rx="1" />
    <rect x="6.5" y="10" width="7.75" height="3" rx="1" />
    <path d="M1.75 8h12.5" strokeOpacity="0.35" />
  </Icon>
);

/** A keyboard edge with notes beside it: the piano roll. */
export const PianoRollIcon = () => (
  <Icon>
    <rect x="1.75" y="2" width="3.5" height="12" rx="0.8" />
    <path d="M1.75 6h2M1.75 10h2" />
    <path d="M8 4.5h3M10 8h4M7.5 11.5h3.5" strokeWidth="2" />
  </Icon>
);

/** A waveform turning into note bars: Audio→MIDI. */
export const AudioToMidiIcon = () => (
  <Icon>
    <path d="M1.5 8h.5M3.5 6v4M5.5 4v8M7.5 6.5v3" />
    <path d="M9.5 8l1 0" strokeOpacity="0.5" />
    <path d="M11.5 5h3M12 8h2.5M11.5 11h3" strokeWidth="2" />
  </Icon>
);

export const ChevronUpIcon = () => (
  <Icon>
    <path d="M4 10l4-4 4 4" />
  </Icon>
);

export const ChevronDownIcon = () => (
  <Icon>
    <path d="M4 6l4 4 4-4" />
  </Icon>
);
