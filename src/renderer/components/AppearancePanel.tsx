// The toolbar's Appearance button and its panel: theme, track colours and the
// background image, all in one place. Every change applies as it is made.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TrackModel } from '../../shared/model';
import { fallbackTrackColor } from '../../shared/palette';
import { PaletteIcon } from './icons';
import { hasProjectColors, PALETTE_CHOICES, resolveTrackColors, type PaletteChoice } from '../theme/palettes';
import { THEMES, type Theme } from '../theme/themes';
import type { AppearanceSettings, BackgroundShowIn, useAppearance } from '../theme/useAppearance';
import type { BackgroundImageState } from '../theme/useBackgroundImage';

type Appearance = ReturnType<typeof useAppearance>;

type Props = {
  appearance: Appearance;
  background: BackgroundImageState;
  /** The open project's tracks, for previewing palettes in their real order. */
  tracks: readonly TrackModel[] | null;
};

const PREVIEW_COUNT = 7;

/** Stand-in tracks for previews when no project is open. */
const SAMPLE_TRACKS: TrackModel[] = Array.from({ length: PREVIEW_COUNT }, (_, index) => ({
  id: `sample${index}`,
  arrangeIndex: index,
  name: `Track ${index + 1}`,
  kind: 'unknown',
  color: fallbackTrackColor(index, 'unknown'),
  colorSource: 'fallback',
  trackRef: index,
  muted: false,
  mutedBy: null,
  volume: null,
  ownVolume: null,
  number: index + 1,
  depth: 0,
  parentId: null,
  stack: null,
  channel: null,
}));

const SHOW_IN: { value: BackgroundShowIn; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'arrange', label: 'Arrange' },
  { value: 'roll', label: 'Piano roll' },
];

/** A miniature of a theme: its roll ground, a few notes in its palette, its playhead. */
function ThemeSwatch({ theme }: { theme: Theme }): JSX.Element {
  const colors = useMemo(() => resolveTrackColors(SAMPLE_TRACKS.slice(0, 4), 'theme', theme), [theme]);
  const notes = [
    { x: 8, y: 9, w: 22 }, { x: 34, y: 15, w: 14 }, { x: 18, y: 21, w: 26 }, { x: 50, y: 27, w: 18 },
  ];
  return (
    <svg className="theme-swatch" viewBox="0 0 80 40" aria-hidden="true" preserveAspectRatio="none">
      <rect width="80" height="40" fill={theme.canvas.rollBg} />
      <rect width="80" height="40" fill={theme.canvas.rollWash[1]} />
      {notes.map((note, i) => (
        <rect key={i} x={note.x} y={note.y} width={note.w} height="4" rx="1" fill={colors[i]} />
      ))}
      <rect x="44" y="0" width="1.5" height="40" fill={theme.canvas.playheadLine} />
      <rect x="0" y="36" width="80" height="4" fill={theme.ui.accent} />
    </svg>
  );
}

function Strip({ colors }: { colors: string[] }): JSX.Element {
  return (
    <span className="palette-strip" aria-hidden="true">
      {colors.map((color, i) => <span key={i} style={{ background: color }} />)}
    </span>
  );
}

export function AppearanceMenu({ appearance, background, tracks }: Props): JSX.Element {
  const { settings, theme, update, reset } = appearance;
  const [open, setOpen] = useState(false);
  // Fixed, anchored to the button's right edge: the toolbar clips its overflow,
  // and the button sits at the toolbar's right-hand end.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const toggle = useCallback(() => {
    setOpen((value) => {
      if (!value && buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
      }
      return !value;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const following = settings.theme === 'system';
  const previewTracks = tracks && tracks.length > 0 ? tracks.slice(0, PREVIEW_COUNT) : SAMPLE_TRACKS;
  const logicAvailable = !!tracks && hasProjectColors(tracks);

  /** Under Match macOS, a card sets the theme for its own half of the day. */
  const pickTheme = (picked: Theme) => {
    if (!following) { update({ theme: picked.id }); return; }
    update(picked.scheme === 'dark' ? { systemDark: picked.id } : { systemLight: picked.id });
  };
  const isChosen = (candidate: Theme): boolean => (following
    ? candidate.id === settings.systemDark || candidate.id === settings.systemLight
    : candidate.id === settings.theme);

  const setBackground = (patch: Partial<AppearanceSettings['background']>) => update({ background: patch });

  return (
    <div className="appearance-root" ref={rootRef}>
      <button
        ref={buttonRef}
        className={`icon${open ? ' active' : ''}`}
        onClick={toggle}
        title="Appearance"
        aria-label="Appearance"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <PaletteIcon />
      </button>
      {open && anchor && (
        <div className="appearance-panel" role="dialog" aria-label="Appearance" style={{ top: anchor.top, right: anchor.right }}>
          <section>
            <div className="appearance-heading">
              <h2>Theme</h2>
              <label className="toggle" title="Switch between a light and a dark theme with macOS">
                <input
                  type="checkbox"
                  checked={following}
                  onChange={(e) => update(e.target.checked
                    // Start from what is showing, in its own half of the day.
                    ? { theme: 'system', [theme.scheme === 'dark' ? 'systemDark' : 'systemLight']: theme.id }
                    : { theme: theme.id })}
                />
                Match macOS
              </label>
            </div>
            {following && (
              <p className="appearance-note">
                Pick one light and one dark theme; macOS decides which shows.
              </p>
            )}
            <div className="theme-grid">
              {THEMES.map((candidate) => (
                <button
                  key={candidate.id}
                  className={`theme-card${isChosen(candidate) ? ' chosen' : ''}${candidate.id === theme.id ? ' showing' : ''}`}
                  onClick={() => pickTheme(candidate)}
                  aria-pressed={isChosen(candidate)}
                  title={`${candidate.name} (${candidate.scheme})`}
                >
                  <ThemeSwatch theme={candidate} />
                  <span className="theme-name">{candidate.name}</span>
                </button>
              ))}
            </div>
            {following && (
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.followContrast}
                  onChange={(e) => update({ followContrast: e.target.checked })}
                />
                Use high contrast with macOS Increase Contrast
              </label>
            )}
          </section>

          <section>
            <div className="appearance-heading"><h2>Track colours</h2></div>
            <div className="palette-list" role="radiogroup" aria-label="Track colours">
              {PALETTE_CHOICES.map((choice) => {
                const chosen = settings.palette === choice.id;
                return (
                  <button
                    key={choice.id}
                    className={`palette-row${chosen ? ' chosen' : ''}`}
                    role="radio"
                    aria-checked={chosen}
                    onClick={() => update({ palette: choice.id as PaletteChoice })}
                  >
                    <span className="palette-name">
                      {choice.name}
                      {choice.id === 'logic' && !logicAvailable && (
                        <span className="palette-hint">not decoded yet — uses theme colours</span>
                      )}
                    </span>
                    <Strip colors={resolveTrackColors(previewTracks, choice.id, theme)} />
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="appearance-heading">
              <h2>Background image</h2>
              {background.image && (
                <button className="link" onClick={() => void background.clear()}>Remove</button>
              )}
            </div>
            <button className="appearance-choose" onClick={() => void background.choose()} disabled={background.busy}>
              {background.name ? <>Replace <span className="file-name">{background.name}</span>…</> : 'Choose image…'}
            </button>
            {background.error && <p className="appearance-note error">{background.error}</p>}
            {background.image && (
              <div className="appearance-sliders">
                <label>
                  <span>Visibility</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(settings.background.opacity * 100)}
                    onChange={(e) => setBackground({ opacity: Number(e.target.value) / 100 })}
                  />
                  <span className="value">{Math.round(settings.background.opacity * 100)}%</span>
                </label>
                <label>
                  <span>Blur</span>
                  <input
                    type="range"
                    min="0"
                    max="40"
                    value={settings.background.blur}
                    onChange={(e) => setBackground({ blur: Number(e.target.value) })}
                  />
                  <span className="value">{settings.background.blur}px</span>
                </label>
                <div className="appearance-showin">
                  <span>Show in</span>
                  <div className="segmented" role="group" aria-label="Show background in">
                    {SHOW_IN.map((option) => (
                      <button
                        key={option.value}
                        className={settings.background.showIn === option.value ? 'active' : ''}
                        onClick={() => setBackground({ showIn: option.value })}
                        aria-pressed={settings.background.showIn === option.value}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>

          <footer>
            <button className="link" onClick={reset}>Reset to defaults</button>
          </footer>
        </div>
      )}
    </div>
  );
}
