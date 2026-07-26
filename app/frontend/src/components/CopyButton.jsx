import { useState, useRef, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';

// Copies a value to the clipboard. RedMan is often reached over plain HTTP on a
// LAN address, where `navigator.clipboard` does not exist because the page is not
// a secure context. The API can also exist but reject (permission denied, document
// not focused), so fall back to a temporary selection before giving up.
function selectionCopy(value) {
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand?.('copy') === true;
  } catch {
    ok = false;
  }
  document.body.removeChild(field);
  return ok;
}

async function copyToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Denied or unfocused — the selection fallback still works in that case
    }
  }
  if (!selectionCopy(value)) throw new Error('Clipboard unavailable');
}

export default function CopyButton({ value, label = 'Copy', className = 'btn btn-ghost btn-sm' }) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy() {
    try {
      await copyToClipboard(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2500);
  }

  const title = state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy — select the text manually' : label;

  return (
    <button type="button" className={className} onClick={handleCopy} title={title} aria-label={title}>
      {state === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : label}</span>
    </button>
  );
}
