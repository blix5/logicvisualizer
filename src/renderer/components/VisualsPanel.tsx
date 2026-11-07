// The toolbar's Visuals button and its panel: presets at the top, then every
// layer for the piano roll or the arrange view, grouped by kind. A layer
// toggles on and off from its row; expanding it shows opacity, intensity,
// behind/in-front placement and its own knobs. Every change applies at once.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, CloseIcon, SparklesIcon } from './icons';
import { CATEGORY_LABELS, layerMeta, LAYER_CATALOG } from '../visuals/catalog';
import { GLHost } from '../visuals/GLHost';
import type { LayerSettings } from '../visuals/settings';
import type { LayerCategory, ParamSpec, ViewKind } from '../visuals/types';
import type { Visuals } from '../visuals/useVisuals';

type Props = {
  visuals: Visuals;
  /** The view showing, which the panel opens on. */
  mode: ViewKind;
};

const VIEWS: { value: ViewKind; label: string }[] = [
  { value: 'roll', label: 'Piano roll' },
  { value: 'arrange', label: 'Arrange' },
];

const CATEGORIES = Object.keys(CATEGORY_LABELS) as LayerCategory[];

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatParam(spec: Extract<ParamSpec, { kind: 'number' }>, value: number): string {
  const digits = spec.step < 0.1 ? 2 : spec.step < 1 ? 1 : 0;
  return `${value.toFixed(digits)}${spec.unit ?? ''}`;
}

function LayerRow({ layer, view, visuals, expanded, onExpand, glOk }: {
  layer: LayerSettings;
  view: ViewKind;
  visuals: Visuals;
  expanded: boolean;
  onExpand: () => void;
  glOk: boolean;
}): JSX.Element | null {
  const meta = layerMeta(layer.id);
  if (!meta) return null;
  const unavailable = !!meta.gl && !glOk;
  const update = (patch: Partial<Omit<LayerSettings, 'id'>>) => visuals.updateLayer(view, layer.id, patch);
  return (
    <div className={`visual-row${layer.enabled ? ' on' : ''}${expanded ? ' expanded' : ''}`}>
      <div className="visual-row-head">
        <label className="toggle" title={unavailable ? 'Needs WebGL2, which is unavailable here' : meta.description}>
          <input
            type="checkbox"
            checked={layer.enabled && !unavailable}
            disabled={unavailable}
            onChange={(e) => update({ enabled: e.target.checked })}
          />
          <span className="visual-name">{meta.label}</span>
        </label>
        {layer.enabled && <span className="visual-badge">{layer.placement === 'back' ? 'behind' : 'front'}</span>}
        <button
          className="visual-expand"
          onClick={onExpand}
          aria-expanded={expanded}
          aria-label={`${meta.label} settings`}
          title="Settings"
        >
          <ChevronDownIcon />
        </button>
      </div>
      {expanded && (
        <div className="visual-settings">
          <p className="appearance-note">{meta.description}{unavailable ? ' Needs WebGL2, which is unavailable here.' : ''}</p>
          <div className="appearance-sliders">
            <label>
              <span>Opacity</span>
              <input
                type="range" min="0" max="100"
                value={Math.round(layer.opacity * 100)}
                onChange={(e) => update({ opacity: Number(e.target.value) / 100 })}
              />
              <span className="value">{percent(layer.opacity)}</span>
            </label>
            <label>
              <span>Intensity</span>
              <input
                type="range" min="0" max="200"
                value={Math.round(layer.intensity * 100)}
                onChange={(e) => update({ intensity: Number(e.target.value) / 100 })}
              />
              <span className="value">{percent(layer.intensity)}</span>
            </label>
            {meta.params.map((spec) => {
              const value = layer.params[spec.key];
              if (spec.kind === 'number') {
                const n = typeof value === 'number' ? value : spec.default;
                return (
                  <label key={spec.key}>
                    <span>{spec.label}</span>
                    <input
                      type="range" min={spec.min} max={spec.max} step={spec.step} value={n}
                      onChange={(e) => update({ params: { [spec.key]: Number(e.target.value) } })}
                    />
                    <span className="value">{formatParam(spec, n)}</span>
                  </label>
                );
              }
              if (spec.kind === 'toggle') {
                return (
                  <label key={spec.key} className="toggle visual-param-toggle">
                    <input
                      type="checkbox"
                      checked={typeof value === 'boolean' ? value : spec.default}
                      onChange={(e) => update({ params: { [spec.key]: e.target.checked } })}
                    />
                    {spec.label}
                  </label>
                );
              }
              const chosen = typeof value === 'string' ? value : spec.default;
              return (
                <div key={spec.key} className="appearance-showin">
                  <span>{spec.label}</span>
                  <div className="segmented" role="group" aria-label={spec.label}>
                    {spec.options.map((option) => (
                      <button
                        key={option.value}
                        className={chosen === option.value ? 'active' : ''}
                        aria-pressed={chosen === option.value}
                        onClick={() => update({ params: { [spec.key]: option.value } })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="appearance-showin">
              <span>Place</span>
              <div className="segmented" role="group" aria-label="Placement">
                {(['back', 'front'] as const).map((placement) => (
                  <button
                    key={placement}
                    className={layer.placement === placement ? 'active' : ''}
                    aria-pressed={layer.placement === placement}
                    onClick={() => update({ placement })}
                    title={placement === 'back' ? 'Over the background, under the notes' : 'Over everything'}
                  >
                    {placement === 'back' ? 'Behind notes' : 'In front'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function VisualsMenu({ visuals, mode }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [view, setView] = useState<ViewKind>(mode);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [glOk, setGlOk] = useState(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const { settings } = visuals;

  const toggle = useCallback(() => {
    setOpen((was) => {
      if (!was) {
        if (buttonRef.current) {
          const rect = buttonRef.current.getBoundingClientRect();
          setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
        }
        setView(mode);
        setGlOk(GLHost.supported);
      }
      return !was;
    });
  }, [mode]);

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

  const list = settings[view];
  const onInView = settings[mode].filter((layer) => layer.enabled).length;
  const grouped = useMemo(() => CATEGORIES.map((category) => ({
    category,
    layers: list.filter((layer) => layerMeta(layer.id)?.category === category),
  })).filter((group) => group.layers.length > 0), [list]);
  const onCount = list.filter((layer) => layer.enabled).length;

  const commitName = () => {
    visuals.savePreset(name);
    setNaming(false);
    setName('');
  };

  return (
    <div className="appearance-root" ref={rootRef}>
      <button
        ref={buttonRef}
        className={`icon${open || onInView > 0 ? ' active' : ''}`}
        onClick={toggle}
        title={onInView > 0 ? `Visuals (${onInView} on)` : 'Visuals'}
        aria-label="Visuals"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <SparklesIcon />
      </button>
      {open && anchor && (
        <div className="appearance-panel visuals-panel" data-scrolls role="dialog" aria-label="Visuals" style={{ top: anchor.top, right: anchor.right }}>
          <section>
            <div className="appearance-heading">
              <h2>Presets</h2>
              {settings.preset === null && (onCount > 0 || settings[view === 'roll' ? 'arrange' : 'roll'].some((l) => l.enabled)) && (
                <span className="visual-custom">Custom</span>
              )}
            </div>
            <div className="preset-grid">
              {visuals.presets.map((preset) => (
                <span key={preset.id} className={`preset-chip${settings.preset === preset.id ? ' chosen' : ''}`}>
                  <button onClick={() => visuals.choosePreset(preset.id)} aria-pressed={settings.preset === preset.id}>
                    {preset.name}
                  </button>
                  {!preset.builtIn && (
                    <button
                      className="preset-delete"
                      onClick={() => visuals.deletePreset(preset.id)}
                      aria-label={`Delete preset ${preset.name}`}
                      title="Delete preset"
                    >
                      <CloseIcon />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <div className="preset-actions">
              {naming ? (
                <form
                  className="preset-save"
                  onSubmit={(e) => { e.preventDefault(); commitName(); }}
                >
                  <input
                    autoFocus
                    value={name}
                    placeholder="Preset name"
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); } }}
                  />
                  <button type="submit">Save</button>
                </form>
              ) : (
                <button className="link" onClick={() => setNaming(true)}>Save current as preset…</button>
              )}
              <button className="link" onClick={visuals.clear}>Turn all off</button>
            </div>
          </section>

          <section>
            <div className="appearance-heading">
              <h2>Layers</h2>
              <div className="segmented" role="group" aria-label="View">
                {VIEWS.map((option) => (
                  <button
                    key={option.value}
                    className={view === option.value ? 'active' : ''}
                    aria-pressed={view === option.value}
                    onClick={() => { setView(option.value); setExpanded(null); }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {grouped.map((group) => (
              <div key={group.category} className="visual-group">
                <h3>{CATEGORY_LABELS[group.category]}</h3>
                {group.layers.map((layer) => (
                  <LayerRow
                    key={layer.id}
                    layer={layer}
                    view={view}
                    visuals={visuals}
                    glOk={glOk}
                    expanded={expanded === layer.id}
                    onExpand={() => setExpanded((current) => (current === layer.id ? null : layer.id))}
                  />
                ))}
              </div>
            ))}
            {LAYER_CATALOG.some((meta) => !meta.views.includes(view)) && (
              <p className="appearance-note visual-footnote">
                Pitch spectrum and Spectrogram trail follow the roll’s pitch rows, so they are piano-roll only.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
