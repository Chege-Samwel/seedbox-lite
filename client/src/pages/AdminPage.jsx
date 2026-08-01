import React, { useEffect, useState, useCallback } from 'react';
import { Copy, TicketPlus, Ban, RotateCcw, Trash2, KeyRound } from 'lucide-react';
import { adminApi } from '../services/api';
import { EmptyState, Spinner } from '../components/ui';
import { useToast } from '../hooks/useToast';

const KEY_STORAGE = 'sb_admin_key';

export default function AdminPage() {
  const toast = useToast();
  const [adminKey, setAdminKey] = useState(sessionStorage.getItem(KEY_STORAGE) || '');
  const [gate, setGate] = useState(!sessionStorage.getItem(KEY_STORAGE));
  const [gateInput, setGateInput] = useState('');
  const [tickets, setTickets] = useState(null);
  const [form, setForm] = useState({ label: '', note: '', daysValid: 30 });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (key = adminKey) => {
    try {
      const data = await adminApi('/api/admin/tickets', key);
      setTickets(data.tickets);
      return true;
    } catch (err) {
      if (String(err.message).includes('Invalid admin key') || String(err.message).includes('forbidden')) {
        setGate(true);
        sessionStorage.removeItem(KEY_STORAGE);
      } else {
        toast('Could not load tickets', 'error');
      }
      return false;
    }
  }, [adminKey, toast]);

  useEffect(() => { if (!gate) { setTickets(null); load(); } }, [gate, load]);

  const unlock = async (e) => {
    e.preventDefault();
    setAdminKey(gateInput);
    sessionStorage.setItem(KEY_STORAGE, gateInput);
    const ok = await load(gateInput);
    if (ok) setGate(false);
    else toast('Invalid admin key', 'error');
  };

  const copy = async (code) => {
    try { await navigator.clipboard.writeText(code); toast('Ticket copied'); }
    catch { toast('Copy failed — select manually', 'error'); }
  };

  const createTicket = async (e) => {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    try {
      const res = await adminApi('/api/admin/tickets', adminKey, {
        method: 'POST',
        body: { label: form.label || 'Guest', note: form.note, daysValid: Number(form.daysValid) || 0 },
      });
      toast(`Ticket created: ${res.ticket.code}`);
      setForm({ label: '', note: '', daysValid: 30 });
      copy(res.ticket.code);
      load();
    } catch (err) { toast(err.message, 'error'); }
    setCreating(false);
  };

  const patch = async (id, body, successMsg) => {
    try {
      await adminApi(`/api/admin/tickets/${id}`, adminKey, { method: 'PATCH', body });
      toast(successMsg);
      load();
    } catch (err) { toast(err.message, 'error'); }
  };

  const remove = async (id) => {
    try {
      await adminApi(`/api/admin/tickets/${id}`, adminKey, { method: 'DELETE' });
      toast('Ticket deleted');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };

  if (gate) {
    return (
      <div className="sb-app">
        <div className="page admin-gate" style={{ paddingTop: 60 }}>
          <form className="login-card" onSubmit={unlock}>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><KeyRound size={20} color="var(--accent)" /> Admin area</h1>
            <p>Manage login tickets. The admin key is your server's <code>ADMIN_PASSWORD</code> env var (default <code>admin123</code> in dev).</p>
            <div className="field">
              <input className="input" type="password" placeholder="Admin key" value={gateInput} onChange={(e) => setGateInput(e.target.value)} autoFocus />
            </div>
            <button className="btn btn-primary" style={{ width: '100%' }}>Unlock</button>
          </form>
        </div>
      </div>
    );
  }

  if (tickets === null) return <div className="page" style={{ paddingTop: 90 }}><Spinner label="Loading tickets…" /></div>;

  return (
    <div className="sb-app">
      <div className="page" style={{ paddingTop: 24 }}>
        <h1 className="page-title">Ticket management</h1>
        <p className="page-sub">Create login tickets for users. A discontinued or expired ticket kills its sessions immediately.</p>

        <form className="pipe-form" onSubmit={createTicket}>
          <div className="cols">
            <div className="field">
              <label>User label</label>
              <input className="input" placeholder="e.g. Alice" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
            <div className="field">
              <label>Valid for (days) — 0 = never expires</label>
              <input className="input" type="number" min="0" value={form.daysValid} onChange={(e) => setForm((f) => ({ ...f, daysValid: e.target.value }))} />
            </div>
            <div className="field span2">
              <label>Note (optional)</label>
              <input className="input" placeholder="e.g. family account" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <button className="btn btn-primary" disabled={creating}><TicketPlus size={16} /> {creating ? 'Creating…' : 'Create ticket'}</button>
        </form>

        {tickets.length === 0 && <EmptyState emoji="🎟️" title="No tickets yet">Create the first one above — a copy of the code lands in your clipboard.</EmptyState>}

        {tickets.length > 0 && (
          <div className="table-wrap">
            <table className="ticket-table">
              <thead>
                <tr>
                  <th>Code</th><th>Label</th><th>Expires</th><th>Last login</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <span className="ticket-code">{t.code}</span>
                      <button className="icon-btn" style={{ width: 26, height: 26, marginLeft: 6 }} title="Copy" onClick={() => copy(t.code)}><Copy size={12} /></button>
                    </td>
                    <td>{t.label}{t.note ? <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t.note}</div> : null}</td>
                    <td>{t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'Never'}</td>
                    <td>{t.lastLoginAt ? new Date(t.lastLoginAt).toLocaleString() : '—'}</td>
                    <td><span className={`status-pill ${t.status}`}>{t.status}</span></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title="Renew +30 days" onClick={() => patch(t.id, { renewDays: 30 }, 'Renewed 30 days')}><RotateCcw /></button>
                      <button className="icon-btn" title={t.revoked ? 'Reactivate' : 'Discontinue'} onClick={() => patch(t.id, { revoked: !t.revoked }, t.revoked ? 'Reactivated' : 'Discontinued — sessions killed')}><Ban /></button>
                      <button className="icon-btn danger" title="Delete" onClick={() => remove(t.id)}><Trash2 /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
