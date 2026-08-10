import { useState, useRef, useEffect, useId } from 'react';
import { MoreVertical } from 'lucide-react';
import './ActionMenu.css';

// Collapses a row of per-item buttons into one control. The actions keep their
// labels here rather than being reduced to icons, so what a button does no
// longer has to be guessed from a shape or discovered by hovering.
export default function ActionMenu({ actions, label = 'Actions' }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = event => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Without this the focus ring is left on a menu that no longer exists.
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const usable = actions.filter(Boolean);
  if (usable.length === 0) return null;

  return (
    <div className="action-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="action-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen(v => !v)}
      >
        <MoreVertical size={16} />
      </button>

      {open && (
        <div className="action-menu-list" id={menuId} role="menu">
          {usable.map(action => {
            const Icon = action.icon;
            return (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                className={`action-menu-item${action.destructive ? ' is-destructive' : ''}`}
                onClick={() => { setOpen(false); action.onSelect(); }}
              >
                {Icon && <Icon size={14} />}
                <span>{action.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
