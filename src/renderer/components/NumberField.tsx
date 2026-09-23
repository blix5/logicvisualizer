// A numeric input that may be emptied while typing.
//
// A controlled <input type="number"> bound straight to a number snaps back to
// a value the moment it is cleared, so replacing "1" means typing beside it.
// This keeps what is typed as a draft: every valid number is applied as it is
// typed, and leaving the field (Return, Escape or a click elsewhere) with it
// empty or invalid puts the last applied value back.
import { useEffect, useState, type InputHTMLAttributes } from 'react';

type NumberFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number;
  onCommit: (value: number) => void;
  /** Whether a typed number may be applied; defaults to any finite number. */
  isValid?: (value: number) => boolean;
};

export function NumberField({ value, onCommit, isValid, onBlur, onKeyDown, ...rest }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

  // Follow outside changes, but never overwrite what is being typed.
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  return (
    <input
      {...rest}
      type="number"
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        setEditing(true);
        setDraft(e.target.value);
        const next = e.target.value.trim() === '' ? Number.NaN : Number(e.target.value);
        if (Number.isFinite(next) && (isValid?.(next) ?? true)) onCommit(next);
      }}
      onBlur={(e) => {
        setEditing(false);
        setDraft(String(value));
        onBlur?.(e);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
