import { useState, useEffect } from 'react';
import { getPairingIncoming, acceptPairing, declinePairing } from '../api/index.js';
import { Radar, X } from 'lucide-react';
import PairingAcceptDialog from './PairingAcceptDialog.jsx';
import './PairingToast.css';

export default function PairingToast() {
  const [requests, setRequests] = useState([]);
  const [processing, setProcessing] = useState(null);
  const [reviewId, setReviewId] = useState(null);
  const [errors, setErrors] = useState({});
  const [pollError, setPollError] = useState(null);

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

  // Derived, so a request that expires or is handled elsewhere closes its dialog
  const reviewRequest = requests.find(r => r.id === reviewId) || null;

  async function handleAccept(id, access) {
    setProcessing(id);
    setErrors(current => ({ ...current, [id]: null }));
    try {
      const result = await acceptPairing(id, access);
      if (!result.error) {
        setReviewId(null);
        setRequests(r => r.filter(p => p.id !== id));
      } else {
        setErrors(current => ({ ...current, [id]: result.error }));
      }
    } catch (err) {
      setErrors(current => ({ ...current, [id]: err.message }));
    }
    setProcessing(null);
  }

  async function handleDecline(id) {
    setProcessing(id);
    setErrors(current => ({ ...current, [id]: null }));
    try {
      await declinePairing(id);
      setReviewId(null);
      setRequests(r => r.filter(p => p.id !== id));
    } catch (err) {
      setErrors(current => ({ ...current, [id]: err.message }));
    }
    setProcessing(null);
  }

  if (requests.length === 0 && !pollError) return null;

  return (
    <>
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
              {errors[r.id] && !reviewRequest && <div className="alert alert-error" role="alert">{errors[r.id]}</div>}
            </div>
            <div className="pairing-toast-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => { setErrors(current => ({ ...current, [r.id]: null })); setReviewId(r.id); }}
                disabled={processing === r.id}
              >
                Accept...
              </button>
              <button
                className="btn btn-ghost btn-sm"
                aria-label={`Decline connection request from ${r.remote_instance}`}
                title="Decline"
                onClick={() => handleDecline(r.id)}
                disabled={processing === r.id}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {reviewRequest && (
        <PairingAcceptDialog
          key={reviewRequest.id}
          request={reviewRequest}
          busy={processing === reviewRequest.id}
          error={errors[reviewRequest.id]}
          onAccept={access => handleAccept(reviewRequest.id, access)}
          onDecline={() => handleDecline(reviewRequest.id)}
          onClose={() => setReviewId(null)}
        />
      )}
    </>
  );
}
