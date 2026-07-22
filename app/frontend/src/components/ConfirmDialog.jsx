import { useRef } from 'react';
import Dialog from './Dialog.jsx';

export default function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}) {
  const cancelRef = useRef(null);
  return (
    <Dialog
      title={title}
      onClose={busy ? undefined : onClose}
      closeOnOverlay={!busy}
      initialFocusRef={cancelRef}
      footer={(
        <div className="modal-footer-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button type="button" className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      )}
    >
      {children}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
    </Dialog>
  );
}