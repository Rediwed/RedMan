import { useState, useEffect, useRef } from 'react';
import { getPairingIncoming, acceptPairing, declinePairing } from '../api/index.js';
import { Radar, X } from 'lucide-react';
import './PairingToast.css';

export default function PairingToast() {
  const [requests, setRequests] = useState([]);
  const [processing, setProcessing] = useState(null);
  const [access, setAccess] = useState({});
  const [errors, setErrors] = useState({});
  const [pollError, setPollError] = useState(null);
  const prevCount = useRef(0);

  useEffect(() => {
    let active = true;

    async function poll() {
      if (!active) return;
      try {
        const data = await getPairingIncoming();
        if (active) {
          setRequests(data);
          setPollError(null);
        }
      } catch (err) {
        if (active) setPollError(err.message);
      }
      if (active) setTimeout(poll, 3000);
    }

    poll();
    return () => { active = false; };
  }, []);

  async function handleAccept(request) {
    const values = access[request.id] || {};
    setProcessing(request.id);
    setErrors(current => ({ ...current, [request.id]: null }));
    try {
      const result = await acceptPairing(request.id, {
        allowed_path_prefix: values.path,
        storage_limit_bytes: Math.round(Number(values.quotaGb) * (1024 ** 3)),
        confirmed_fingerprint: values.fingerprint,
      });
      if (!result.error) {
        setRequests(r => r.filter(p => p.id !== request.id));
      } else {
        setErrors(current => ({ ...current, [request.id]: result.error }));
      }
    } catch (err) {
      setErrors(current => ({ ...current, [request.id]: err.message }));
    }
    setProcessing(null);
  }

  async function handleDecline(id) {
    setProcessing(id);
    setErrors(current => ({ ...current, [id]: null }));
    try {
      await declinePairing(id);
      setRequests(r => r.filter(p => p.id !== id));
    } catch (err) {
      setErrors(current => ({ ...current, [id]: err.message }));
    }
    setProcessing(null);
  }

  if (requests.length === 0 && !pollError) return null;

  return (
    <div className="pairing-toast-container">
      {pollError && <div className="pairing-toast alert alert-error" role="alert">Pairing requests unavailable: {pollError}</div>}
      {requests.map(r => (
        <div key={r.id} className="pairing-toast">
          <div className="pairing-toast-icon">
            <Radar size={24} />
          </div>
          <div className="pairing-toast-body">
            <div className="pairing-toast-title">Connection Request</div>
            <div className="pairing-toast-message">
              <strong>{r.remote_instance}</strong> wants to connect
            </div>
            {errors[r.id] && <div className="alert alert-error" role="alert">{errors[r.id]}</div>}
            <div className="pairing-toast-fingerprint">
              Compare on the initiator: <code>{r.remote_fingerprint}</code>
            </div>
            <div className="pairing-toast-fields">
              <input
                aria-label={`Backup directory for ${r.remote_instance}`}
                placeholder="/mnt/user/backups/peer"
                value={access[r.id]?.path || ''}
                onChange={event => setAccess(current => ({
                  ...current,
                  [r.id]: { ...current[r.id], path: event.target.value },
                }))}
              />
              <input
                aria-label={`Storage quota in GB for ${r.remote_instance}`}
                type="number"
                min="1"
                placeholder="Quota GB"
                value={access[r.id]?.quotaGb || ''}
                onChange={event => setAccess(current => ({
                  ...current,
                  [r.id]: { ...current[r.id], quotaGb: event.target.value },
                }))}
              />
              <input
                className="pairing-toast-fingerprint-input"
                aria-label={`Confirm fingerprint for ${r.remote_instance}`}
                placeholder="Type fingerprint to confirm"
                value={access[r.id]?.fingerprint || ''}
                onChange={event => setAccess(current => ({
                  ...current,
                  [r.id]: { ...current[r.id], fingerprint: event.target.value },
                }))}
              />
            </div>
          </div>
          <div className="pairing-toast-actions">
            <button className="btn btn-primary btn-sm" onClick={() => handleAccept(r)} disabled={processing === r.id || !access[r.id]?.path || !(Number(access[r.id]?.quotaGb) > 0) || access[r.id]?.fingerprint?.replace(/[^a-f0-9]/gi, '').toUpperCase() !== r.remote_fingerprint?.replace(/[^a-f0-9]/gi, '').toUpperCase()}>
              {processing === r.id ? '...' : 'Accept'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => handleDecline(r.id)} disabled={processing === r.id}>
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
