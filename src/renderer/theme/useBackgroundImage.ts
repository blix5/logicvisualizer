// The background image: loaded from app storage at startup, decoded once into
// an ImageBitmap for the renderers, and replaced or removed from the
// Appearance panel.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isFailure, type BackgroundImage } from '../../shared/ipc';

export type BackgroundImageState = {
  image: ImageBitmap | null;
  name: string | null;
  busy: boolean;
  error: string | null;
  choose(): Promise<void>;
  clear(): Promise<void>;
};

async function decode(file: BackgroundImage): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([file.bytes], { type: file.type }));
}

export function useBackgroundImage(): BackgroundImageState {
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<ImageBitmap | null>(null);

  /** Swaps in a new bitmap, releasing the old one's memory. */
  const replace = useCallback((next: ImageBitmap | null, nextName: string | null) => {
    const previous = current.current;
    current.current = next;
    setImage(next);
    setName(nextName);
    // After React has handed the new one to the renderers.
    if (previous && previous !== next) setTimeout(() => previous.close(), 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await window.lv.appearance.background();
      if (cancelled || isFailure(stored) || !stored) return;
      try {
        const bitmap = await decode(stored);
        if (cancelled) { bitmap.close(); return; }
        replace(bitmap, stored.name);
      } catch {
        setError(`Could not read the background image ${stored.name}.`);
      }
    })();
    return () => { cancelled = true; };
  }, [replace]);

  const choose = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await window.lv.appearance.chooseBackground();
      if (isFailure(picked)) { setError(picked.error); return; }
      if (!picked) return;
      try {
        replace(await decode(picked), picked.name);
      } catch {
        // Main has already replaced the stored image, so the old one is gone too.
        setError(`Could not read ${picked.name} as an image.`);
        await window.lv.appearance.clearBackground();
        replace(null, null);
      }
    } finally {
      setBusy(false);
    }
  }, [replace]);

  const clear = useCallback(async () => {
    setError(null);
    const result = await window.lv.appearance.clearBackground();
    if (isFailure(result)) { setError(result.error); return; }
    replace(null, null);
  }, [replace]);

  return { image, name, busy, error, choose, clear };
}
