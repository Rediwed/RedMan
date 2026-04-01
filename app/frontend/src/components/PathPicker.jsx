import { useState, useEffect } from 'react';
import { FolderOpen, FolderClosed, ArrowUp, HardDrive, Home, Check } from 'lucide-react';
import { browseDirectory, getFilesystemRoots, getSsdShares } from '../api/index.js';
import PillTabs from './PillTabs.jsx';
import './PathPicker.css';

const PICKER_TABS = [
  { value: 'browse', label: 'Browse' },
  { value: 'drives', label: 'Drives & Shares' },
];

export default function PathPicker({ value, onChange, label, placeholder }) {
  const [browsing, setBrowsing] = useState(false);
  const [tab, setTab] = useState('browse');
  const [roots, setRoots] = useState([]);
  const [shares, setShares] = useState([]);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getFilesystemRoots().then(setRoots).catch(() => {});
    getSsdShares().then(setShares).catch(() => {});
  }, []);

  async function navigate(path) {
    setLoading(true);
    try {
      const result = await browseDirectory(path);
      setCurrentPath(result.current);
      setParentPath(result.parent);
      setEntries(result.entries);
    } catch {
      setEntries([]);
    }
    setLoading(false);
  }

  function openBrowser() {
    setBrowsing(true);
    setCurrentPath('');
    setEntries([]);
    setTab('browse');
  }

  function selectPath(path) {
    onChange(path);
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
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder || '/mnt/user/share'}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={openBrowser}>
          <FolderOpen size={14} /> Browse
        </button>
      </div>

      {browsing && (
        <div className="modal-overlay" onClick={() => setBrowsing(false)}>
          <div className="modal picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2><FolderOpen size={18} /> Select Directory</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setBrowsing(false)}>✕</button>
            </div>
            <div className="modal-body">
              <PillTabs tabs={PICKER_TABS} active={tab} onChange={setTab} />

              {tab === 'browse' && (
                <>
                  {!currentPath ? (
                    <>
                      <p className="form-hint" style={{ marginBottom: 'var(--space-md)' }}>Choose a starting point:</p>
                      <div className="browse-grid">
                        {roots.map(r => (
                          <button key={r.path} className="browse-share" onClick={() => navigate(r.path)}>
                            <span className="browse-share-name">
                              {r.icon === 'home' ? <Home size={14} /> : <HardDrive size={14} />} {r.name}
                            </span>
                            <span className="browse-share-desc">{r.path}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="browse-path-bar">
                        <button className="btn btn-ghost btn-sm" onClick={goUp} disabled={parentPath === currentPath}>
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
                            <button key={e.path} className="browse-entry" onClick={() => navigate(e.path)}>
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
                    {shares.length > 0 ? 'Detected shares and mount points:' : 'No shares detected. Use the Browse tab to navigate manually.'}
                  </p>
                  {shares.length > 0 && (
                    <div className="browse-grid">
                      {shares.map(s => (
                        <button key={s.name} className="browse-share" onClick={() => selectPath(s.userPath || s.cachePath || s.path)}>
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

            {currentPath && tab === 'browse' && (
              <div className="modal-footer">
                <button className="btn btn-ghost" onClick={() => { setCurrentPath(''); setEntries([]); }}>
                  Back to Roots
                </button>
                <button className="btn btn-primary" onClick={() => selectPath(currentPath)}>
                  <Check size={14} /> Select "{currentPath.split('/').pop() || '/'}"
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
