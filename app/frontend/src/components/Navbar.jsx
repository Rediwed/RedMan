import { NavLink } from 'react-router-dom';
import { LayoutDashboard, HardDrive, RefreshCw, Cloud, Camera, Settings } from 'lucide-react';
import ConnectionStatus from './ConnectionStatus.jsx';
import './Navbar.css';

export default function Navbar() {
  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <svg className="navbar-logo" width="28" height="28" viewBox="0 0 512 512">
          <defs>
            <linearGradient id="navShieldGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#cc1818"/>
              <stop offset="50%" stopColor="#9e0e0e"/>
              <stop offset="100%" stopColor="#640a0a"/>
            </linearGradient>
            <linearGradient id="navShieldEdge" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7e0c0c"/>
              <stop offset="100%" stopColor="#420606"/>
            </linearGradient>
            <linearGradient id="navSheen" x1="0.3" y1="0" x2="0.7" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.18"/>
              <stop offset="40%" stopColor="#ffffff" stopOpacity="0.05"/>
              <stop offset="100%" stopColor="#000000" stopOpacity="0.1"/>
            </linearGradient>
            <linearGradient id="navServerBar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff"/>
              <stop offset="100%" stopColor="#f0e0e0"/>
            </linearGradient>
          </defs>
          <path d="M256 44 L440 120 L440 284 C440 388 344 464 256 488 C168 464 72 388 72 284 L72 120 Z" fill="url(#navShieldEdge)"/>
          <path d="M256 54 L430 126 L430 280 C430 380 338 452 256 476 C174 452 82 380 82 280 L82 126 Z" fill="url(#navShieldGrad)"/>
          <path d="M256 54 L430 126 L430 280 C430 380 338 452 256 476 C174 452 82 380 82 280 L82 126 Z" fill="url(#navSheen)"/>
          <g transform="translate(256,128)">
            <rect x="-18" y="-18" width="36" height="36" rx="4" transform="rotate(45)" fill="none" stroke="#fef2f4" strokeWidth="5" opacity="0.95"/>
            <rect x="-9" y="-9" width="18" height="18" rx="2" transform="rotate(45)" fill="#fef2f4" opacity="0.3"/>
          </g>
          <rect x="172" y="190" width="168" height="36" rx="6" fill="url(#navServerBar)" opacity="0.92"/>
          <rect x="172" y="238" width="168" height="36" rx="6" fill="url(#navServerBar)" opacity="0.92"/>
          <rect x="172" y="286" width="168" height="36" rx="6" fill="url(#navServerBar)" opacity="0.92"/>
          <circle cx="320" cy="208" r="5.5" fill="#16a34a"/>
          <circle cx="320" cy="208" r="3" fill="#4ade80" opacity="0.7"/>
          <circle cx="320" cy="256" r="5.5" fill="#16a34a"/>
          <circle cx="320" cy="256" r="3" fill="#4ade80" opacity="0.7"/>
          <circle cx="320" cy="304" r="5.5" fill="#2563eb"/>
          <circle cx="320" cy="304" r="3" fill="#60a5fa" opacity="0.7"/>
          <line x1="256" y1="154" x2="256" y2="184" stroke="#fef2f4" strokeWidth="2.5" opacity="0.4" strokeDasharray="4,4"/>
        </svg>
        <span className="navbar-title">RedMan</span>
        <ConnectionStatus />
      </div>
      <div className="navbar-links">
        <NavLink to="/" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'} end>
          <LayoutDashboard size={16} /> Overview
        </NavLink>
        <NavLink to="/ssd-backup" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          <HardDrive size={16} /> SSD Backup
        </NavLink>
        <NavLink to="/hyper-backup" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          <RefreshCw size={16} /> Hyper Backup
        </NavLink>
        <NavLink to="/rclone" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          <Cloud size={16} /> Rclone
        </NavLink>
        <NavLink to="/media-import" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          <Camera size={16} /> Media Import
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
          <Settings size={16} /> Settings
        </NavLink>
      </div>
    </nav>
  );
}
