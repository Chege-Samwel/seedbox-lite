/**
 * Session auth — the app boots by validating the stored session token against
 * the server. If the ticket was discontinued or expired on the admin side, the
 * user lands on the ticket login screen with a precise reason.
 */
import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { getToken, setToken, loginWithTicket, validateSession, logoutSession } from '../services/api';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};

// Re-validate the ticket every 5 minutes so admin discontinuations take effect
// without an app restart.
const REVALIDATE_MS = 5 * 60 * 1000;

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const intervalRef = useRef(null);

  const clearAuth = useCallback((message = null) => {
    setToken(null);
    localStorage.removeItem('sb_user');
    setUser(null);
    if (message) setAuthError(message);
  }, []);

  const checkServer = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setIsLoading(false);
      return;
    }
    try {
      const data = await validateSession();
      setUser(data.user);
      localStorage.setItem('sb_user', JSON.stringify(data.user));
      setAuthError(null);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        clearAuth(err?.data?.message || 'Your session is no longer valid.');
      } else {
        // Server unreachable — keep the session alive using the cached profile;
        // every API call still enforces auth once the server is back.
        const cached = localStorage.getItem('sb_user');
        if (cached) {
          try { setUser((u) => u || JSON.parse(cached)); } catch { /* ignore */ }
        }
      }
    } finally {
      setIsLoading(false);
    }
  }, [clearAuth]);

  // Boot: look for the stored ticket session and validate it
  useEffect(() => { checkServer(); }, [checkServer]);

  // Periodic re-validation while the app is open
  useEffect(() => {
    if (!user) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return undefined;
    }
    intervalRef.current = setInterval(checkServer, REVALIDATE_MS);
    return () => clearInterval(intervalRef.current);
  }, [user, checkServer]);

  const login = useCallback(async (ticketCode) => {
    setAuthError(null);
    try {
      const data = await loginWithTicket(ticketCode.trim());
      setToken(data.token);
      setUser(data.user);
      return { ok: true };
    } catch (err) {
      const message = err?.data?.error || 'Login failed — check your ticket code.';
      setAuthError(message);
      return { ok: false, error: message };
    }
  }, []);

  const logout = useCallback(async () => {
    await logoutSession();
    clearAuth();
  }, [clearAuth]);

  return (
    <AuthContext.Provider value={{ isAuthenticated: !!user, user, isLoading, authError, login, logout, setAuthError }}>
      {children}
    </AuthContext.Provider>
  );
};
