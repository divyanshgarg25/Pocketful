import { useEffect, useRef } from 'react';

export function useModalA11y(isOpen: boolean, onClose: () => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    // Save previous active element to restore focus on close
    previousFocusRef.current = document.activeElement as HTMLElement | null;

    // Body scroll lock
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Focus first focusable element inside modal
    const focusableSelector =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const focusable = containerRef.current?.querySelectorAll<HTMLElement>(focusableSelector);
    if (focusable && focusable.length > 0) {
      focusable[0]?.focus();
    }

    // Escape key listener & focus trap
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }

      if (e.key === 'Tab' && containerRef.current) {
        const elements = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(focusableSelector)
        ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);

        if (elements.length === 0) return;

        const first = elements[0];
        const last = elements[elements.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  return containerRef;
}
