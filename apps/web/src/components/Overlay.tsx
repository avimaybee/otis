import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
/** Native modal semantics provide focus containment and make background content inert. */
export function Overlay({ label, className = '', onClose, children, initialFocus }: { label: string; className?: string; onClose: () => void; children: ReactNode; initialFocus?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    initialFocus?.current?.focus();
    const onBack = () => closeRef.current();
    window.addEventListener('popstate', onBack);
    return () => { window.removeEventListener('popstate', onBack); dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} aria-label={label} className={`otis-overlay ${className}`} onCancel={event => { event.preventDefault(); onClose(); }}>
    {children}
  </dialog>;
}
