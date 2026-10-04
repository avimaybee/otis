import { useCallback, useEffect, useState } from 'react';

export const VIEWPORT_HEIGHT_VAR = '--app-viewport-height';
export const COMPOSER_HEIGHT_VAR = '--app-composer-height';

/**
 * The single viewport/keyboard measurement owner.
 *
 * Observes visualViewport resize AND scroll where available (iOS Safari
 * shifts the visual viewport on keyboard/pinch without a resize event;
 * `interactive-widget=resizes-content` only affects Android Chrome), plus
 * window resize as fallback, and the actual mounted composer element through
 * one ResizeObserver. Publishes the measured viewport and composer heights
 * as CSS custom properties — the layout contract consumers read — and
 * nothing else. No keyboard-open inference: every viewport change is not a
 * keyboard, and orientation/browser-chrome changes must not move the reader.
 *
 * The composer is tracked by mounted element (callback ref), never by a
 * stable ref object: a read-only view has no composer node, switching to an
 * own chat mounts a new one, and replacing the composer must move the
 * observer off the old node. Observers and listeners disconnect on unmount,
 * node replacement and route transitions, so stale callbacks never touch a
 * new chat. State updates publish only when a measurement actually changed,
 * so observers never cause resize feedback loops.
 */
export function useViewportComposer(): (node: HTMLElement | null) => void {
  const [composerNode, setComposerNode] = useState<HTMLElement | null>(null);
  const composerRef = useCallback((node: HTMLElement | null) => {
    setComposerNode(node);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const readViewport = () => Math.round(viewport?.height ?? window.innerHeight);
    let composerHeight = 0;
    const publish = () => {
      const viewportHeight = readViewport();
      const root = document.documentElement;
      if (root.style.getPropertyValue(VIEWPORT_HEIGHT_VAR) !== `${viewportHeight}px`) {
        root.style.setProperty(VIEWPORT_HEIGHT_VAR, `${viewportHeight}px`);
      }
      const composerValue = `${Math.round(composerHeight)}px`;
      if (root.style.getPropertyValue(COMPOSER_HEIGHT_VAR) !== composerValue) {
        root.style.setProperty(COMPOSER_HEIGHT_VAR, composerValue);
      }
    };
    publish();
    let observer: ResizeObserver | null = null;
    if (composerNode && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(entries => {
        const next = entries[0]?.contentRect.height ?? 0;
        if (next !== composerHeight) {
          composerHeight = next;
          publish();
        }
      });
      observer.observe(composerNode);
    }
    viewport?.addEventListener('resize', publish);
    viewport?.addEventListener('scroll', publish);
    window.addEventListener('resize', publish);
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener('resize', publish);
      viewport?.removeEventListener('scroll', publish);
      window.removeEventListener('resize', publish);
      document.documentElement.style.removeProperty(VIEWPORT_HEIGHT_VAR);
      document.documentElement.style.removeProperty(COMPOSER_HEIGHT_VAR);
    };
  }, [composerNode]);

  return composerRef;
}
