// A toolbar dropdown drawn by the app rather than the OS. A native <select>
// keeps keyboard focus after a pick, and while it has focus Space opens it
// instead of playing. This one never takes focus: the button skips focus on
// mousedown, and the menu closes (and gives nothing focus) as soon as a value
// is picked. The menu is positioned fixed, since the toolbar clips overflow.
import { useCallback, useEffect, useRef, useState } from 'react';

export type DropdownOption<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  options: readonly DropdownOption<T>[];
  value: T;
  onChange: (value: T) => void;
  title?: string;
  ariaLabel: string;
};

export function Dropdown<T extends string>({ options, value, onChange, title, ariaLabel }: Props<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  /** Keyboard highlight while open, as an index into options. */
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  activeRef.current = active;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  const toggle = useCallback(() => {
    setOpen((was) => {
      if (!was && buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setAnchor({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
        setActive(Math.max(0, options.findIndex((option) => option.value === value)));
      }
      return !was;
    });
  }, [options, value]);

  const pick = useCallback((next: T) => {
    setOpen(false);
    onChange(next);
  }, [onChange]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    // Capture phase, ahead of the app's own shortcuts: while the menu is open
    // the arrows, Enter and Escape belong to it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((index) => (index + step + options.length) % options.length);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const option = options[activeRef.current];
        if (option) pick(option.value);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, options, pick]);

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        ref={buttonRef}
        className={`dropdown-button${open ? ' active' : ''}`}
        // No focus from a click, so Space keeps playing and pausing.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{current?.label}</span>
        <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M0 0l4 5 4-5z" fill="currentColor" /></svg>
      </button>
      {open && anchor && (
        <div
          className="dropdown-menu"
          data-scrolls
          role="listbox"
          aria-label={ariaLabel}
          style={{ top: anchor.top, left: anchor.left, minWidth: anchor.minWidth }}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`dropdown-option${option.value === value ? ' selected' : ''}${index === active ? ' highlighted' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option.value)}
            >
              <span className="check" aria-hidden="true">{option.value === value ? '✓' : ''}</span>
              {option.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
