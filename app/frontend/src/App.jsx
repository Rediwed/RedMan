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
import ExternalJobsPage from './pages/ExternalJobsPage.jsx';
import StatusPage from './pages/StatusPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import VersionBadge from './components/VersionBadge.jsx';
import LoginPage from './pages/LoginPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import { AuthProvider, useAuth } from './contexts/AuthContext.jsx';
import './App.css';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </AuthProvider>
  );
}

function AuthGate() {
  const auth = useAuth();
  if (auth.loading) return <div className="empty-state auth-loading"><p>Checking authentication...</p></div>;
  if (!auth.user) return <LoginPage />;
  return <AuthenticatedApplication />;
}

function AuthenticatedApplication() {
  const auth = useAuth();
  useBrowserNotifications();
  return (
    <SettingsProvider>
      <div className="app">
        <Navbar />
        {auth.isAdmin && <PairingToast />}
        <main className="main-content">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/ssd-backup" element={<SsdBackupPage />} />
            <Route path="/hyper-backup" element={<HyperBackupPage />} />
            <Route path="/rclone" element={<RclonePage />} />
            <Route path="/media-import" element={<MediaImportPage />} />
            <Route path="/external-jobs" element={<ExternalJobsPage />} />
            <Route path="/status" element={<StatusPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/settings" element={auth.isAdmin ? <SettingsPage /> : <AccessDenied />} />
          </Routes>
        </main>
        <VersionBadge />
      </div>
    </SettingsProvider>
  );
}

function AccessDenied() {
  return <div className="empty-state"><h1>Access denied</h1><p>Administrator permission is required for this page.</p></div>;
}
