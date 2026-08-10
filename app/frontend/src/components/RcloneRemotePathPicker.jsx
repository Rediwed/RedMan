import { useState, useRef, useEffect } from 'react';
import { FolderOpen, FolderClosed, ArrowUp, Check, Cloud } from 'lucide-react';
import { browseRemote } from '../api/index.js';
import { DialogSurface } from './Dialog.jsx';
import './PathPicker.css';

// rclone reports a directory listing relative to the path it was asked about,
// so the full path is accumulated here rather than read off an entry.
function childPath(currentPath, name) {
  return currentPath ? `${currentPath}/${name}` : name;
}

function parentOf(path) {
  const segments = path.split('/');
  segments.pop();
  return segments.join('/');
}

export default function RcloneRemotePathPicker({ value, onChange, remoteName, placeholder, disabled, required }) {
  const [browsing, setBrowsing] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // A listing over a cloud link can take seconds. Without a sequence number a
  // slow answer for one folder can overwrite the listing of the folder you
  // moved on to — and Select would then write a path from the wrong place.
  const requestSequence = useRef(0);

  // Switching remote invalidates everything the picker is holding.
  useEffect(() => {
    requestSequence.current += 1;
    setCurrentPath('');
    setEntries([]);
    setError(null);
    setNotice(null);
  }, [remoteName]);

  async function navigate(path) {
    const ticket = ++requestSequence.current;
    setLoading(true);
    setError(null);
    // Set before the call, not after: a listing over a slow cloud link takes
    // seconds, and until then the bar would name the folder you just left.
    setCurrentPath(path);
    try {
      const result = await browseRemote(remoteName, path);
      if (ticket !== requestSequence.current) return false;
      setEntries(Array.isArray(result) ? result : []);
      return true;
    } catch (err) {
      if (ticket !== requestSequence.current) return false;
      setError(err.message);
      setEntries([]);
      return false;
    } finally {
      if (ticket === requestSequence.current) setLoading(false);
    }
  }

  async function openBrowser() {
    setBrowsing(true);
    setError(null);
    setNotice(null);
    setEntries([]);
    setCurrentPath('');
    // Start where the field already points, so editing a job does not send you
    // back to the top of the drive. A path that cannot be opened is worth
    // saying out loud rather than leaving as a dead end.
    if (value && !(await navigate(value))) {
      setNotice(`“${value}” could not be opened — showing the top of ${remoteName} instead.`);
      await navigate('');
    } else if (!value) {
      await navigate('');
    }
  }

  function selectPath(path) {
    onChange(path);
    setBrowsing(false);
  }

  return (
    <div className="path-picker">
      <div className="path-input-group">
        <div className="path-input-wrapper">
          <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder || 'Backups/Nextcloud'}
            required={required}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={openBrowser}
          disabled={disabled || !remoteName}
          title={remoteName ? 'Browse this remote' : 'Select a remote first'}
        >
          <FolderOpen size={14} /> Browse
        </button>
      </div>

      {browsing && (
        <DialogSurface
          ariaLabel={`Browse ${remoteName}`}
          className="picker-modal"
          onClose={() => setBrowsing(false)}
        >
          <div className="modal-header">
            <h2><Cloud size={18} /> Browse {remoteName}</h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Close remote browser"
              title="Close"
              onClick={() => setBrowsing(false)}
            >✕</button>
          </div>

          <div className="modal-body">
            <div className="browse-path-bar">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigate(parentOf(currentPath))}
                disabled={!currentPath || loading}
              >
                <ArrowUp size={14} /> Up
              </button>
              <code className="browse-current-path">{remoteName}:{currentPath}</code>
            </div>

            {notice && <p className="browse-hint" role="status">{notice}</p>}

            {error ? (
              <div className="alert alert-error" role="alert">{error}</div>
            ) : loading ? (
              <p className="browse-hint">Loading...</p>
            ) : entries.length === 0 ? (
              <p className="browse-hint">No folders here.</p>
            ) : (
              <div className="browse-list">
                {entries.map(entry => (
                  <button
                    type="button"
                    key={entry.ID || entry.Name}
                    className="browse-entry"
                    onClick={() => navigate(childPath(currentPath, entry.Name))}
                  >
                    <FolderClosed size={14} /> {entry.Name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={() => setBrowsing(false)}>Cancel</button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => selectPath(currentPath)}
              disabled={!currentPath || loading || !!error}
              title={currentPath ? '' : 'Open a folder to select it'}
            >
              <Check size={14} /> Select &quot;{currentPath.split('/').pop() || '/'}&quot;
            </button>
          </div>
        </DialogSurface>
      )}
    </div>
  );
}
