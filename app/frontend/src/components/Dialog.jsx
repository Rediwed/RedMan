import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const dialogStack = [];
let inertDepth = 0;
let rootWasAriaHidden = null;
let bodyOverflow = '';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export default function Dialog({
  title,
  children,
  footer,
  onClose,
  className = '',
  closeOnOverlay = true,
  initialFocusRef,
}) {
  const titleId = useId();
  return (
    <DialogSurface
      ariaLabelledBy={titleId}
      className={className}
      closeOnOverlay={closeOnOverlay}
      initialFocusRef={initialFocusRef}
      onClose={onClose}
    >
      <div className="modal-header">
        <h2 id={titleId}>{title}</h2>
        {onClose && (
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close dialog" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </DialogSurface>
  );
}

export function DialogSurface({
  children,
  onClose,
  className = '',
  closeOnOverlay = true,
  initialFocusRef,
  ariaLabel,
  ariaLabelledBy,
  style,
}) {
  const dialogRef = useRef(null);
  const openerRef = useRef(null);
  const stackIdRef = useRef(Symbol('dialog'));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const stackId = stackIdRef.current;
    const root = document.getElementById('root');
    openerRef.current = document.activeElement;
    dialogStack.push(stackId);

    if (inertDepth++ === 0) {
      rootWasAriaHidden = root?.getAttribute('aria-hidden');
      bodyOverflow = document.body.style.overflow;
      if (root) {
        root.inert = true;
        root.setAttribute('aria-hidden', 'true');
      }
      document.body.style.overflow = 'hidden';
    }

    const focusInitial = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const target = initialFocusRef?.current
        || dialog?.querySelector('[data-autofocus]')
        || dialog?.querySelector(FOCUSABLE)
        || dialog;
      target?.focus();
    });

    const handleKeyDown = event => {
      if (dialogStack.at(-1) !== stackId) return;
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(focusInitial);
      document.removeEventListener('keydown', handleKeyDown);
      const stackIndex = dialogStack.lastIndexOf(stackId);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      if (--inertDepth === 0) {
        if (root) {
          root.inert = false;
          if (rootWasAriaHidden === null) root.removeAttribute('aria-hidden');
          else root.setAttribute('aria-hidden', rootWasAriaHidden);
        }
        document.body.style.overflow = bodyOverflow;
      }
      openerRef.current?.focus?.();
    };
  }, [initialFocusRef]);

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (closeOnOverlay && event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal ${className}`.trim()}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}