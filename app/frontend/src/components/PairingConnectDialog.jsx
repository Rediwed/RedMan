import { useState } from 'react';
import { Radar, ArrowLeftRight } from 'lucide-react';
import Dialog from './Dialog.jsx';
import PathPicker from './PathPicker.jsx';
import './PairingAcceptDialog.css';

const GB = 1024 ** 3;
const EXAMPLE_QUOTA_GB = 1024; // 1 TB

export default function PairingConnectDialog({ peer, busy, onConnect, onCancel }) {
  const [offerReciprocal, setOfferReciprocal] = useState(false);
  const [path, setPath] = useState('');
  const [quotaGb, setQuotaGb] = useState('');

  const quota = Number(quotaGb);
  const quotaValid = Number.isFinite(quota) && quota > 0 && Number.isSafeInteger(Math.round(quota * GB));
  const offerValid = Boolean(path.trim()) && quotaValid;
  const canConnect = !busy && (!offerReciprocal || offerValid);

  function submit() {
    if (!canConnect) return;
    onConnect(offerReciprocal
      ? { allowed_path_prefix: path.trim(), storage_limit_bytes: Math.round(quota * GB) }
      : null);
  }

  return (
    <Dialog
      title={<><Radar size={18} aria-hidden="true" /> Connect to {peer.instance}</>}
      onClose={busy ? undefined : onCancel}
      footer={(
        <div className="modal-footer-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canConnect}>
            {busy ? 'Connecting...' : 'Send Request'}
          </button>
        </div>
      )}
    >
      <div className="pairing-accept-summary">
        <span className="pairing-accept-peer">{peer.instance}</span>
        <span className="pairing-accept-detail">will be asked to accept this connection</span>
        <code className="pairing-accept-url">{peer.url}</code>
      </div>

      <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
        The operator on the other side decides how much space you get and confirms your identity fingerprint
        before anything is set up.
      </p>

      <div className="pairing-accept-reciprocal">
        <label className="toggle-label">
          <input
            type="checkbox"
            className="toggle"
            checked={offerReciprocal}
            onChange={event => setOfferReciprocal(event.target.checked)}
          />
          <span>
            <ArrowLeftRight size={14} aria-hidden="true" /> Also let {peer.instance} back up to me
          </span>
        </label>
        <p className="form-hint">
          Offers this peer space on this instance in the same request, so you do not have to repeat the whole
          pairing from the other side. The offer is signed, and the other operator still has to accept it.
        </p>

        {offerReciprocal && (
          <>
            <div className="form-group" style={{ marginTop: 'var(--space-md)' }}>
              <label>Backup location you offer</label>
              <PathPicker
                value={path}
                onChange={setPath}
                label="Backup location you offer"
                placeholder="/mnt/user/backups/peer"
              />
              <p className="form-hint">
                {peer.instance} can only read and write below this directory.
              </p>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="pairing-connect-quota">Storage quota you offer (GB)</label>
              <input
                id="pairing-connect-quota"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                placeholder={String(EXAMPLE_QUOTA_GB)}
                value={quotaGb}
                onChange={event => setQuotaGb(event.target.value)}
              />
              <p className="form-hint">For example {EXAMPLE_QUOTA_GB} GB = 1 TB.</p>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
