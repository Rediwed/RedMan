import { useState, useEffect, useRef } from 'react';
import { getPairingIncoming, acceptPairing, declinePairing } from '../api/index.js';
import { Radar, X } from 'lucide-react';
import './PairingToast.css';

export default function PairingToast() {
  const [requests, setRequests] = useState([]);
  const [processing, setProcessing] = useState(null);
  const prevCount = useRef(0);

  useEffect(() => {
    let active = true;

    async function poll() {
      if (!active) return;
      try {
        const data = await getPairingIncoming();
        if (active) setRequests(data);
      } catch { /* silent */ }
      if (active) setTimeout(poll, 3000);
    }

    poll();
    return () => { active = false; };
  }, []);

  async function handleAccept(id) {
    setProcessing(id);
    try {
      const result = await acceptPairing(id);
      if (!result.error) {
        setRequests(r => r.filter(p => p.id !== id));
      }
    } catch { /* silent */ }
    setProcessing(null);
  }

  async function handleDecline(id) {
    setProcessing(id);
    try {
      await declinePairing(id);
      setRequests(r => r.filter(p => p.id !== id));
    } catch { /* silent */ }
    setProcessing(null);
  }

  if (requests.length === 0) return null;

  return (
    <div className="pairing-toast-container">
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
          </div>
          <div className="pairing-toast-actions">
            <button className="btn btn-primary btn-sm" onClick={() => handleAccept(r.id)} disabled={processing === r.id}>
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
