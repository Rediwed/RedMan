import { useState, useEffect } from 'react';
import { FolderOpen, FolderClosed, ArrowUp, HardDrive, Home, Check } from 'lucide-react';
import { browseRemotePeer, getRemotePeerRoots, getRemotePeerShares } from '../api/index.js';
import PillTabs from './PillTabs.jsx';
import { DialogSurface } from './Dialog.jsx';
import './PathPicker.css';

const PICKER_TABS = [
  { value: 'browse', label: 'Browse' },
  { value: 'drives', label: 'Drives & Shares' },
];

export default function RemotePathPicker({ value, onChange, onBrowse, placeholder, remoteUrl, disabled }) {
  const [browsing, setBrowsing] = useState(false);
  const [tab, setTab] = useState('browse');
  const [roots, setRoots] = useState([]);
  const [shares, setShares] = useState([]);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Reload roots & shares when the remote URL changes
  useEffect(() => {
    if (!remoteUrl) return;
    getRemotePeerRoots(remoteUrl).then(setRoots).catch(() => setRoots([]));
    getRemotePeerShares(remoteUrl).then(setShares).catch(() => setShares([]));
  }, [remoteUrl]);

  async function navigate(path) {
    setLoading(true);
    setError(null);
    try {
      const result = await browseRemotePeer(remoteUrl, path);
      setCurrentPath(result.current);
      setParentPath(result.parent);
      setEntries(result.entries);
    } catch (err) {
      setError(err.message);
      setEntries([]);
    }
    setLoading(false);
  }

  function openBrowser() {
    setBrowsing(true);
    setCurrentPath('');
    setEntries([]);
    setError(null);
    setTab('browse');
  }

  function selectPath(path) {
    (onBrowse || onChange)(path);
    setBrowsing(false);
  }

  function goUp() {
    if (parentPath && parentPath !== currentPath) {
      navigate(parentPath);
    }
  }

  return (
    <div className="path-picker">
      <div className="path-input-group">
        <div className="path-input-wrapper">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder || '/mnt/user/Backups'}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={openBrowser}
          disabled={disabled || !remoteUrl}
          title={!remoteUrl ? 'Select a destination first' : 'Browse remote directories'}
        >
          <FolderOpen size={14} /> Browse
        </button>
      </div>

      {browsing && (
        <DialogSurface ariaLabel="Browse remote directory" className="picker-modal" onClose={() => setBrowsing(false)}>
            <div className="modal-header">
              <h2><FolderOpen size={18} /> Browse Remote Directory</h2>
              <button type="button" className="btn btn-ghost btn-sm" aria-label="Close remote directory picker" title="Close" onClick={() => setBrowsing(false)}>✕</button>
            </div>
            <div className="modal-body">
              <PillTabs tabs={PICKER_TABS} active={tab} onChange={setTab} />

              {tab === 'browse' && (
                <>
                  {error ? (
                    <div className="alert alert-error">{error}</div>
                  ) : !currentPath ? (
                    <>
                      <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>Choose a starting point:</p>
                      <div className="browse-grid">
                        {roots.map(r => (
                          <button type="button" key={r.path} className="browse-share" onClick={(e) => { e.stopPropagation(); navigate(r.path); }}>
                            <span className="browse-share-name">
                              {r.icon === 'home' ? <Home size={14} /> : <HardDrive size={14} />} {r.name}
                            </span>
                            <span className="browse-share-desc">{r.path}</span>
                          </button>
                        ))}
                      </div>
                      {roots.length === 0 && (
                        <p className="browse-hint">No accessible roots found on this peer.</p>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="browse-path-bar">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={goUp} disabled={parentPath === currentPath}>
                          <ArrowUp size={14} /> Up
                        </button>
                        <code className="browse-current-path">{currentPath}</code>
                      </div>
                      {loading ? (
                        <p className="browse-hint">Loading...</p>
                      ) : entries.length === 0 ? (
                        <p className="browse-hint">Empty directory</p>
                      ) : (
                        <div className="browse-list">
                          {entries.map(e => (
                            <button type="button" key={e.path} className="browse-entry" onClick={() => navigate(e.path)}>
                              <FolderClosed size={14} /> {e.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {tab === 'drives' && (
                <>
                  <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>
                    {shares.length > 0 ? 'Detected shares and mount points:' : 'No shares detected on this peer. Use the Browse tab to navigate manually.'}
                  </p>
                  {shares.length > 0 && (
                    <div className="browse-grid">
                      {shares.map(s => (
                        <button type="button" key={s.name} className="browse-share" onClick={(e) => { e.stopPropagation(); selectPath(s.userPath || s.cachePath || s.path); }}>
                          <span className="browse-share-name"><HardDrive size={14} /> {s.name}</span>
                          {s.comment && <span className="browse-share-desc">{s.comment}</span>}
                          <span className="browse-share-path">{s.userPath || s.cachePath || ''}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {currentPath && tab === 'browse' && !error && (
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => { setCurrentPath(''); setEntries([]); setError(null); }}>
                  Back to Roots
                </button>
                <button type="button" className="btn btn-primary" onClick={() => selectPath(currentPath)}>
                  <Check size={14} /> Select "{currentPath.split('/').pop() || '/'}"
                </button>
              </div>
            )}
        </DialogSurface>
      )}
    </div>
  );
}
