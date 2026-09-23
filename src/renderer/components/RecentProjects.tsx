// Recently opened projects: a localStorage-backed list, plus the empty-screen
// grid and the toolbar dropdown that show it. Thumbnails come from the
// WindowImage.jpg inside each .logicx bundle, read on demand via project.preview
// and cached in memory for the session (never stored — the images are large).
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { RecentPreview } from '../../shared/ipc';
import { isFailure } from '../../shared/ipc';
import { CloseIcon, FolderIcon } from './icons';

export type RecentProject = { path: string; name: string; lastOpened: number };

const STORAGE_KEY = 'lv.recentProjects';
const MAX_RECENTS = 12;

/** Reads the stored recents. Storage can throw or hold junk; fall back to none. */
function readRecents(): RecentProject[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is RecentProject =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as RecentProject).path === 'string'
        && typeof (entry as RecentProject).name === 'string'
        && typeof (entry as RecentProject).lastOpened === 'number')
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function writeRecents(recents: RecentProject[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    // Per-session only; losing the list is harmless.
  }
}

export type RecentsController = {
  recents: RecentProject[];
  record: (entry: RecentProject) => void;
  remove: (path: string) => void;
};

/** The recents list plus mutators, kept in sync with localStorage. */
export function useRecentProjects(): RecentsController {
  const [recents, setRecents] = useState<RecentProject[]>(readRecents);

  const record = useCallback((entry: RecentProject) => {
    setRecents((current) => {
      const next = [entry, ...current.filter((item) => item.path !== entry.path)].slice(0, MAX_RECENTS);
      writeRecents(next);
      return next;
    });
  }, []);

  const remove = useCallback((path: string) => {
    setRecents((current) => {
      const next = current.filter((item) => item.path !== path);
      writeRecents(next);
      return next;
    });
  }, []);

  return { recents, record, remove };
}

// Fetched once per path per session; a bump forces re-render when a fetch lands.
const previewCache = new Map<string, RecentPreview>();

/** The preview for a path, or undefined while it is still loading. */
function useProjectPreview(path: string): RecentPreview | undefined {
  const [, bump] = useState(0);
  const cached = previewCache.get(path);

  useEffect(() => {
    if (previewCache.has(path)) return;
    let cancelled = false;
    void window.lv.project.preview(path).then((result) => {
      if (cancelled) return;
      previewCache.set(path, isFailure(result) ? { exists: false, dataUrl: null, hasBounce: false } : result);
      bump((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [path]);

  return cached;
}

/** "3:42 PM today" is overkill here; a short relative-ish date is enough. */
function formatWhen(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type CardProps = {
  entry: RecentProject;
  dense?: boolean;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  onBounceCleared?: (path: string) => void;
};

function RecentCard({ entry, dense, onOpen, onRemove, onBounceCleared }: CardProps): JSX.Element {
  const preview = useProjectPreview(entry.path);
  const [bounceCleared, setBounceCleared] = useState(false);
  const unavailable = preview?.exists === false;
  const dataUrl = preview?.dataUrl ?? null;
  const hasBounce = (preview?.hasBounce ?? false) && !bounceCleared;

  const clearBounce = useCallback(async (event: ReactMouseEvent) => {
    event.stopPropagation();
    const result = await window.lv.bounce.clear(entry.path);
    if (isFailure(result)) return;
    setBounceCleared(true);
    // Keep the session cache honest so the chip stays gone on re-mount.
    const cached = previewCache.get(entry.path);
    if (cached) previewCache.set(entry.path, { ...cached, hasBounce: false });
    onBounceCleared?.(entry.path);
  }, [entry.path, onBounceCleared]);

  return (
    <div className={`recent-card${dense ? ' dense' : ''}${unavailable ? ' unavailable' : ''}`}>
      <button
        className="recent-open"
        onClick={() => onOpen(entry.path)}
        title={unavailable ? `${entry.path} (unavailable)` : entry.path}
      >
        <span className="recent-thumb">
          {dataUrl
            ? <img src={dataUrl} alt="" draggable={false} />
            : <span className="recent-thumb-placeholder"><FolderIcon /></span>}
          {unavailable && <span className="recent-badge">unavailable</span>}
          {hasBounce && (
            <span
              className="recent-bounce"
              role="button"
              tabIndex={0}
              onClick={clearBounce}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') void clearBounce(event as unknown as ReactMouseEvent); }}
              title="Clear saved bounce"
              aria-label={`Clear saved bounce for ${entry.name}`}
            >
              <span className="recent-bounce-text">bounce</span>
              <CloseIcon />
            </span>
          )}
        </span>
        <span className="recent-meta">
          <span className="recent-name">{entry.name}</span>
          <span className="recent-when">{formatWhen(entry.lastOpened)}</span>
        </span>
      </button>
      <button
        className="recent-remove"
        onClick={(event) => { event.stopPropagation(); onRemove(entry.path); }}
        title="Remove from recents"
        aria-label={`Remove ${entry.name} from recents`}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

type GridProps = {
  recents: RecentProject[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  onBounceCleared?: (path: string) => void;
};

/** The empty-screen quick-access grid. Renders nothing when there are no recents. */
export function RecentGrid({ recents, onOpen, onRemove, onBounceCleared }: GridProps): JSX.Element | null {
  if (recents.length === 0) return null;
  return (
    <div className="recent-grid">
      {recents.map((entry) => (
        <RecentCard key={entry.path} entry={entry} onOpen={onOpen} onRemove={onRemove} onBounceCleared={onBounceCleared} />
      ))}
    </div>
  );
}

type MenuProps = {
  recents: RecentProject[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  onOpenNew: () => void;
  onBounceCleared?: (path: string) => void;
  disabled?: boolean;
};

/** The toolbar folder button and its recents dropdown. */
export function RecentMenu({ recents, onOpen, onRemove, onOpenNew, onBounceCleared, disabled }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // The toolbar clips its overflow, so the panel is positioned fixed, anchored to
  // the button's on-screen rect rather than nested in the (clipped) toolbar flow.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const toggle = useCallback(() => {
    setOpen((value) => {
      if (!value && buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setAnchor({ top: rect.bottom + 6, left: rect.left });
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

  const handleOpen = useCallback((path: string) => { setOpen(false); onOpen(path); }, [onOpen]);
  const handleOpenNew = useCallback(() => { setOpen(false); onOpenNew(); }, [onOpenNew]);

  return (
    <div className="recent-menu-root" ref={rootRef}>
      <button
        ref={buttonRef}
        className={`icon${open ? ' active' : ''}`}
        onClick={toggle}
        disabled={disabled}
        title="Open project"
        aria-label="Open project"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FolderIcon />
      </button>
      {open && anchor && (
        <div className="recent-menu" data-scrolls role="menu" style={{ top: anchor.top, left: anchor.left }}>
          {recents.length > 0 && (
            <div className="recent-menu-list">
              {recents.map((entry) => (
                <RecentCard key={entry.path} entry={entry} dense onOpen={handleOpen} onRemove={onRemove} onBounceCleared={onBounceCleared} />
              ))}
            </div>
          )}
          <button className="recent-menu-new" onClick={handleOpenNew} role="menuitem">
            Open new .logicx…
          </button>
        </div>
      )}
    </div>
  );
}
