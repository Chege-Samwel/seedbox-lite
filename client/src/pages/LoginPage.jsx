import React, { useState } from 'react';
import { Leaf } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { login, authError, setAuthError } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    await login(code);
    setBusy(false);
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <span className="brand" style={{ fontSize: 22 }}>
          <span className="leaf"><Leaf size={24} /></span>
          SeedBox<small>Lite</small>
        </span>
        <h1>Enter your ticket</h1>
        <p>Access is by invitation only. Enter the login ticket code you received from the administrator.</p>
        {authError && <div className="error-banner">{authError}</div>}
        <div className="field">
          <input
            className="input ticket-input"
            placeholder="SB-XXXX-XXXX"
            value={code}
            onChange={(e) => { setCode(e.target.value); setAuthError(null); }}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck="false"
            maxLength={20}
          />
        </div>
        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy || !code.trim()}>
          {busy ? 'Checking ticket…' : 'Sign in'}
        </button>
        <p style={{ marginTop: 18, marginBottom: 0, fontSize: 12, textAlign: 'center' }}>
          Tickets can be discontinued or renewed by the administrator at any time.
        </p>
      </form>
    </div>
  );
}
