import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, matchPath } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './hooks/useToast';
import NavBar from './components/NavBar';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import SearchPage from './pages/SearchPage';
import { ArchiveDetails, ShowDetails } from './pages/DetailsPage';
import PlayerPage from './pages/PlayerPage';
import LibraryPage from './pages/LibraryPage';
import HistoryPage from './pages/HistoryPage';
import AdminPage from './pages/AdminPage';
import './styles/stream.css';

function Splash() {
  return (
    <div className="center-wrap" style={{ minHeight: '100dvh' }}>
      <div className="spinner" />
      <p>Checking your ticket…</p>
    </div>
  );
}

function Protected({ children }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <Splash />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function Shell({ children }) {
  const location = useLocation();
  const isPlayer = matchPath('/watch/*', location.pathname);
  return (
    <>
      {!isPlayer && <NavBar />}
      {children}
    </>
  );
}

function AppRoutes() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <Splash />;
  return (
    <Shell>
      <Routes>
        <Route path="/login" element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />} />
        <Route path="/" element={<Protected><HomePage /></Protected>} />
        <Route path="/search" element={<Protected><SearchPage /></Protected>} />
        <Route path="/title/archive/:identifier" element={<Protected><ArchiveDetails /></Protected>} />
        <Route path="/title/show/:name" element={<Protected><ShowDetails /></Protected>} />
        <Route path="/watch/:source" element={<Protected><PlayerPage /></Protected>} />
        <Route path="/library" element={<Protected><LibraryPage /></Protected>} />
        <Route path="/history" element={<Protected><HistoryPage /></Protected>} />
        <Route path="/admin" element={<Protected><AdminPage /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Router>
          <AppRoutes />
        </Router>
      </ToastProvider>
    </AuthProvider>
  );
}
