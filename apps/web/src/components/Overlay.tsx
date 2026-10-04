import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useOverlayHistory } from './overlay-history.js';
/** Native modal semantics provide focus containment and make background content inert. */
let openOverlays = 0;
export function Overlay({ label, className = '', onClose, children, initialFocus }: { label: string; className?: string; onClose: () => void; children: ReactNode; initialFocus?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const nestedRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Dismissal, Back handling and marker ownership live in the shared hook,
  // also used by the Vaul history drawer: exactly one owner, no parallel
  // modal implementations drifting apart.
  useOverlayHistory(label, true, onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    nestedRef.current = openOverlays > 0;
    if (nestedRef.current) dialog?.classList.add('otis-overlay--nested');
    openOverlays += 1;
    dialog?.showModal();
    initialFocus?.current?.focus();

    const handleClick = (event: MouseEvent) => {
      if (event.target === dialog) {
        closeRef.current();
      }
    };
    dialog?.addEventListener('click', handleClick);

    return () => {
      dialog?.removeEventListener('click', handleClick);
      dialog?.close();
      previous?.focus();
      openOverlays = Math.max(0, openOverlays - 1);
    };
  }, []);
  return <dialog ref={ref} aria-label={label} className={`otis-overlay ${className}`} onCancel={event => { event.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}
