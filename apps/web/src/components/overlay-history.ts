import { useEffect, useRef } from 'react';

/**
 * Single owner for overlay dismissal and overlay Back handling, shared by
 * the native dialog (Overlay) and the Vaul history drawer.
 *
 * Opening an overlay pushes one same-URL history entry carrying that
 * overlay's marker, so system Back closes the top overlay instead of
 * navigating to another chat or workspace. No chat navigation entry is
 * added: the URL never changes. Closing explicitly (Close, backdrop,
 * Escape, swipe) consumes the marker with history.back() only when this
 * overlay's marker is still on top; a marker already left behind by a real
 * navigation is never blindly rewound. The top-marker recheck is deferred
 * one microtask because typed-router navigations land in the real history
 * on a microtask: reading state synchronously on unmount would mistake a
 * fresh navigation for our marker and rewind it.
 */

let overlaySequence = 0;
const OVERLAY_MARKER_KEY = 'otisOverlay';

function readMarker(): string | null {
  try {
    const state = window.history.state as Record<string, unknown> | null;
    const marker = state?.[OVERLAY_MARKER_KEY];
    return typeof marker === 'string' ? marker : null;
  } catch {
    return null;
  }
}

export function useOverlayHistory(label: string, active: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const markerRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    overlaySequence += 1;
    const marker = `${label}:${overlaySequence}`;
    markerRef.current = marker;
    try {
      window.history.pushState(
        { ...((window.history.state as Record<string, unknown> | null) ?? {}), [OVERLAY_MARKER_KEY]: marker },
        '',
        window.location.href,
      );
    } catch {
      markerRef.current = null;
    }
    const onBack = () => closeRef.current();
    window.addEventListener('popstate', onBack);
    return () => {
      window.removeEventListener('popstate', onBack);
      const owned = markerRef.current;
      markerRef.current = null;
      if (!owned) return;
      queueMicrotask(() => {
        try {
          if (readMarker() === owned) window.history.back();
        } catch {
          /* Back is best-effort; the route itself is unchanged. */
        }
      });
    };
  }, [label, active]);
}
