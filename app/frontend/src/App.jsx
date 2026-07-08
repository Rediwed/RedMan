import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { SettingsProvider } from './contexts/SettingsContext.jsx';
import Navbar from './components/Navbar.jsx';
import PairingToast from './components/PairingToast.jsx';
import useBrowserNotifications from './hooks/useBrowserNotifications.js';
import OverviewPage from './pages/OverviewPage.jsx';
import SsdBackupPage from './pages/SsdBackupPage.jsx';
import HyperBackupPage from './pages/HyperBackupPage.jsx';
import RclonePage from './pages/RclonePage.jsx';
import MediaImportPage from './pages/MediaImportPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import './App.css';

export default function App() {
  useBrowserNotifications();
  return (
    <BrowserRouter>
      <SettingsProvider>
      <div className="app">
        <Navbar />
        <PairingToast />
        <main className="main-content">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/ssd-backup" element={<SsdBackupPage />} />
            <Route path="/hyper-backup" element={<HyperBackupPage />} />
            <Route path="/rclone" element={<RclonePage />} />
            <Route path="/media-import" element={<MediaImportPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
      </SettingsProvider>
    </BrowserRouter>
  );
}
