import React, { useEffect, useState } from 'react';
import { Leaf, Server, X, AlertTriangle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiBase, setApiBaseOverride, requiresServerOverride, isNetlify } from '../services/api';

export default function LoginPage() {
  const { login, authError, setAuthError } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState(null); // { host, ok }
  const [serverAddr, setServerAddr] = useState(() => localStorage.getItem('sb_api_base_override') || '');
  const [savedAddr, setSavedAddr] = useState(() => localStorage.getItem('sb_api_base_override') || '');

  // Live reachability chip: pings the API the login will actually use and
  // shows WHERE it points — a baked-in placeholder/wrong base (the classic
  // production trap) becomes immediately visible instead of a vague error.
  useEffect(() => {
    let stop = false;
    const check = async () => {
      const base = apiBase() || window.location.origin;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(`${base}/api/health?ngrok-skip-browser-warning=1`, {
          signal: ctrl.signal,
          headers: { 'ngrok-skip-browser-warning': 'true' },
        });
        clearTimeout(t);
        const data = await r.json().catch(() => null);
        if (!stop) setProbe({ host: base, ok: r.ok && data?.status === 'ok' });
      } catch {
        if (!stop) setProbe({ host: base, ok: false });
      }
    };
    check();
    const timer = setInterval(check, 10000);
    window.addEventListener('sb_api_base_changed', check);
    return () => { stop = true; clearInterval(timer); window.removeEventListener('sb_api_base_changed', check); };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    await login(code);
    setBusy(false);
  };

  const applyServerAddr = () => {
    setApiBaseOverride(serverAddr);
    const applied = apiBase();
    setServerAddr(applied);
    setSavedAddr(applied);
    setProbe(null); // the sb_api_base_changed listener re-probes immediately
  };

  const needOverride = requiresServerOverride() && !savedAddr;
  const onNetlify = isNetlify();

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <span className="brand" style={{ fontSize: 22 }}>
          <span className="leaf"><Leaf size={24} /></span>
          Heiken
        </span>
        <h1>Enter your ticket</h1>
        <p>Access is by invitation only. Enter the login ticket code you received from the administrator.</p>
        {authError && <div className="error-banner">{authError}</div>}
        {onNetlify && needOverride && (
          <div className="error-banner" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800 }}><AlertTriangle size={16} /> Server address required</span>
            <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              You are on Netlify (static UI). Video/data <strong>never</strong> goes through Netlify — it streams directly from your Heiken engine.
              Paste your engine's public URL below (ngrok / Cloudflare Tunnel / VPS). Example: <code>https://xxxx.ngrok-free.app</code>
            </span>
          </div>
        )}
        {probe && (
          <p style={{ margin: '8px 0 0', fontSize: 11.5, textAlign: 'center', color: probe.ok ? '#4caf86' : '#e07a5f' }}>
            API @ {probe.host} — {probe.ok ? 'reachable ✓' : 'unreachable ✗ (server down, or set server address below)'}
          </p>
        )}
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
        <details open={needOverride} style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim, #9aa)' }}>
          <summary style={{ cursor: 'pointer' }}><Server size={12} style={{ verticalAlign: -2 }} /> Server address (split hosting) — data goes direct to server, never through Netlify</summary>
          <div style={{ margin: '8px 0 0', display: 'flex', gap: 6, flexDirection: 'column' }}>
            <p style={{ margin: 0, lineHeight: 1.5 }}>
              The static UI (Netlify) is just a shell. All API, torrent metadata, and video bytes stream <strong>directly</strong> from your Heiken engine to this browser — never proxied through Netlify.
              Paste your engine's public URL here once per device (no rebuild needed). If you use a Cloudflare <em>quick</em> tunnel, its URL changes every run:
            </p>
            <input
              className="input"
              placeholder="https://your-tunnel-url.trycloudflare.com"
              value={serverAddr}
              onChange={(e) => setServerAddr(e.target.value)}
              inputMode="url"
              autoComplete="off"
              spellCheck="false"
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-primary btn-sm" style={{ flex: 1 }} onClick={applyServerAddr} disabled={serverAddr.trim() === savedAddr}>
                {savedAddr ? 'Update server' : 'Use this server'}
              </button>
              {savedAddr && (
                <button
                  type="button"
                  className="btn btn-dark btn-sm"
                  title="Clear and use the baked VITE_API_BASE_URL"
                  onClick={() => { setApiBaseOverride(''); setServerAddr(''); setSavedAddr(''); setProbe(null); }}
                >
                  <X size={13} /> Clear
                </button>
              )}
            </div>
            {savedAddr && (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-faint, #889)' }}>
                Saved for this device: {savedAddr}
              </p>
            )}
          </div>
        </details>
        <details style={{ marginTop: 12, fontSize: 12, color: 'var(--text-dim, #9aa)' }}>
          <summary style={{ cursor: 'pointer' }}>Server owner? Common mix-ups</summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
            <li>This box wants a <strong>ticket code</strong> (<code>SB-XXXX-XXXX</code>) — <em>not</em> the admin key. The admin key (<code>ADMIN_PASSWORD</code>) unlocks <code>/admin</code> &lt;[...]&gt;</li>
            <li>The owner ticket prints in the server log <strong>once, on first boot only</strong>. Lost it? Run <code>npm run tickets</code> on the server (or <code>npm run new-ticket</code>). &lt;[...]&gt;</li>
            <li>Blank/bounced logins from another device usually mean the UI was built with a wrong <code>VITE_API_BASE_URL</code> — same-origin serving (<code>npm start</code>) needs nothing c&lt;...&gt;</li>
          </ul>
        </details>
      </form>
    </div>
  );
}
