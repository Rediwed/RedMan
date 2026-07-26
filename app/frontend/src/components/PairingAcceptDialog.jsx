import { useState } from 'react';
import { Radar, Fingerprint, ArrowLeftRight } from 'lucide-react';
import Dialog from './Dialog.jsx';
import PathPicker from './PathPicker.jsx';
import CopyButton from './CopyButton.jsx';
import { formatBytes } from '../utils/formatBytes.js';
import './PairingAcceptDialog.css';

const GB = 1024 ** 3;
const EXAMPLE_QUOTA_GB = 1024; // 1 TB

function normalizeFingerprint(value) {
  return String(value || '').replace(/[^a-f0-9]/gi, '').toUpperCase();
}

function formatQuota(gb) {
  if (!(gb > 0)) return null;
  return gb >= 1024 ? `${(gb / 1024).toFixed(gb % 1024 === 0 ? 0 : 1)} TB` : `${gb} GB`;
}

export default function PairingAcceptDialog({ request, busy, error, onAccept, onDecline, onClose }) {
  const [path, setPath] = useState('');
  const [quotaGb, setQuotaGb] = useState('');
  const [fingerprint, setFingerprint] = useState('');

  // Only an offer the peer signed into its request can be taken up
  const offer = request.reciprocal_path && request.reciprocal_limit_bytes > 0
    ? { path: request.reciprocal_path, limit: request.reciprocal_limit_bytes }
    : null;
  const [acceptReciprocal, setAcceptReciprocal] = useState(Boolean(offer));

  const quota = Number(quotaGb);
  const quotaValid = Number.isFinite(quota) && quota > 0 && Number.isSafeInteger(Math.round(quota * GB));
  const expectedFingerprint = normalizeFingerprint(request.remote_fingerprint);
  const enteredFingerprint = normalizeFingerprint(fingerprint);
  const fingerprintMatches = expectedFingerprint.length > 0 && enteredFingerprint === expectedFingerprint;
  const canAccept = Boolean(path.trim()) && quotaValid && fingerprintMatches && !busy;

  function submit() {
    if (!canAccept) return;
    onAccept({
      allowed_path_prefix: path.trim(),
      storage_limit_bytes: Math.round(quota * GB),
      confirmed_fingerprint: fingerprint,
      accept_reciprocal: Boolean(offer) && acceptReciprocal,
    });
  }

  return (
    <Dialog
      title={<><Radar size={18} aria-hidden="true" /> Accept Connection Request</>}
      onClose={busy ? undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onDecline} disabled={busy}>
            Decline
          </button>
          <div className="modal-footer-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={!canAccept}>
              {busy ? 'Connecting...' : 'Accept & Connect'}
            </button>
          </div>
        </>
      )}
    >
      <div className="pairing-accept-summary">
        <span className="pairing-accept-peer">{request.remote_instance}</span>
        <span className="pairing-accept-detail">wants to back up to this instance</span>
        {request.remote_url && <code className="pairing-accept-url">{request.remote_url}</code>}
      </div>

      <div className="pairing-accept-fingerprint">
        <div className="pairing-accept-fingerprint-label">
          <Fingerprint size={14} aria-hidden="true" /> Identity fingerprint
        </div>
        <div className="pairing-accept-fingerprint-value">
          <code>{request.remote_fingerprint || 'Not provided'}</code>
          {expectedFingerprint && <CopyButton value={request.remote_fingerprint} />}
        </div>
        <p className="form-hint">
          {expectedFingerprint
            ? <>This must match the fingerprint shown on the peer that is connecting. If it differs, decline — someone else is answering for that peer.</>
            : <span className="pairing-accept-mismatch">This peer sent no fingerprint, so its identity cannot be verified. Decline it and re-send the request from an up-to-date RedMan.</span>}
        </p>
      </div>

      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <div className="form-group">
        <label>Backup location</label>
        <PathPicker
          value={path}
          onChange={setPath}
          label="Backup location"
          placeholder="/mnt/user/backups/peer"
        />
        <p className="form-hint">
          {request.remote_instance} can only read and write below this directory. Pick a dedicated folder — never a
          whole share you also use yourself.
        </p>
      </div>

      <div className="form-group">
        <label htmlFor="pairing-accept-quota">Storage quota (GB)</label>
        <input
          id="pairing-accept-quota"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          placeholder={String(EXAMPLE_QUOTA_GB)}
          value={quotaGb}
          onChange={event => setQuotaGb(event.target.value)}
        />
        <p className="form-hint">
          For example {EXAMPLE_QUOTA_GB} GB = 1 TB.
          {quotaValid && <> This peer gets <strong>{formatQuota(quota)}</strong>.</>}
        </p>
      </div>

      <div className="form-group">
        <label htmlFor="pairing-accept-fingerprint">Confirm fingerprint</label>
        <input
          id="pairing-accept-fingerprint"
          className="pairing-accept-fingerprint-input"
          autoComplete="off"
          spellCheck="false"
          placeholder="Type the fingerprint shown above"
          value={fingerprint}
          onChange={event => setFingerprint(event.target.value)}
        />
        <p className="form-hint">
          {enteredFingerprint && !fingerprintMatches
            ? <span className="pairing-accept-mismatch">This does not match the fingerprint above.</span>
            : 'Typing it yourself confirms you compared both sides.'}
        </p>
      </div>

      {offer && (
        <div className="pairing-accept-reciprocal">
          <label className="toggle-label">
            <input
              type="checkbox"
              className="toggle"
              checked={acceptReciprocal}
              onChange={event => setAcceptReciprocal(event.target.checked)}
            />
            <span>
              <ArrowLeftRight size={14} aria-hidden="true" /> Also back up to this peer
            </span>
          </label>
          <p className="form-hint">
            It offers <code>{offer.path}</code> with <strong>{formatBytes(offer.limit)}</strong> in return, so both
            directions are set up at once. Leave this off to only receive backups.
          </p>
        </div>
      )}
    </Dialog>
  );
}
