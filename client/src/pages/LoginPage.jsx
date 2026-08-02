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
        <details style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim, #9aa)' }}>
          <summary style={{ cursor: 'pointer' }}>Server owner? Common mix-ups</summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
            <li>This box wants a <strong>ticket code</strong> (<code>SB-XXXX-XXXX</code>) — <em>not</em> the admin key. The admin key (<code>ADMIN_PASSWORD</code>) unlocks <code>/admin</code> <em>after</em> you are signed in.</li>
            <li>The owner ticket prints in the server log <strong>once, on first boot only</strong>. Lost it? Run <code>npm run tickets</code> on the server (or <code>npm run new-ticket</code>).</li>
            <li>Blank/bounced logins from another device usually mean the UI was built with a wrong <code>VITE_API_BASE_URL</code> — same-origin serving (<code>npm start</code>) needs nothing configured.</li>
          </ul>
        </details>
      </form>
    </div>
  );
}
