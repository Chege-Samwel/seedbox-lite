import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Trash2, Image, ClipboardPaste, Pencil } from 'lucide-react';
import { getLibrary, addToLibrary, removeLibraryItem, updateLibraryItem, refreshArtwork } from '../services/api';
import { ReadyBadge, EmptyState, Modal, Spinner, PosterImage } from '../components/ui';
import { formatBytes, formatSpeed } from '../utils/format';
import { useToast } from '../hooks/useToast';

const POLL_MS = 3500;

export default function LibraryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [form, setForm] = useState({ magnet: '', title: '', kind: 'movie', showName: '', season: '', episode: '' });
  const [adding, setAdding] = useState(false);
  const [artPick, setArtPick] = useState(null); // { item, alternatives }
  const [editing, setEditing] = useState(null); // item being edited
  const mounted = useRef(true);

  const refresh = useCallback(async (silent = false) => {
    try {
      const data = await getLibrary();
      if (mounted.current) setItems(data.items);
    } catch {
      if (!silent) toast('Could not load pipeline', 'error');
    }
  }, [toast]);

  useEffect(() => {
    mounted.current = true;
    refresh(true);
    const t = setInterval(() => mounted.current && refresh(true), POLL_MS);
    return () => { mounted.current = false; clearInterval(t); };
  }, [refresh]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setForm((f) => ({ ...f, magnet: text.trim() }));
    } catch { toast('Clipboard unavailable — paste manually', 'error'); }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.magnet.trim() || adding) return;
    setAdding(true);
    try {
      const payload = {
        magnet: form.magnet.trim(),
        title: form.title.trim() || undefined,
        kind: form.kind,
        showName: form.kind === 'episode' ? form.showName.trim() || undefined : undefined,
        season: form.kind === 'episode' && form.season !== '' ? parseInt(form.season, 10) : undefined,
        episode: form.kind === 'episode' && form.episode !== '' ? parseInt(form.episode, 10) : undefined,
      };
      const res = await addToLibrary(payload);
      toast(res.duplicate ? 'That magnet is already in your pipeline' : 'Added — warming up the stream');
      setForm({ magnet: '', title: '', kind: 'movie', showName: '', season: '', episode: '' });
      await refresh(true);
    } catch (err) { toast(err.message, 'error'); }
    setAdding(false);
  };

  const doArtRefresh = async (item, body = {}) => {
    try {
      const res = await refreshArtwork(item.id, body);
      if (res.ok) {
        toast('Artwork updated');
        if (res.alternatives?.length > 1 && !body.pick) setArtPick({ item, alternatives: res.alternatives });
        refresh(true);
      } else toast(res.error || 'No artwork found', 'error');
    } catch { toast('Artwork lookup failed', 'error'); }
  };

  const pickArt = async (pickIndex) => {
    const item = artPick.item;
    setArtPick(null);
    await doArtRefresh(item, { pick: pickIndex });
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    try {
      await updateLibraryItem(editing.id, {
        title: editing.title,
        kind: editing.kind,
        showName: editing.showName || undefined,
        season: editing.season !== '' && editing.season != null ? parseInt(editing.season, 10) : null,
        episode: editing.episode !== '' && editing.episode != null ? parseInt(editing.episode, 10) : null,
      });
      toast('Saved');
      setEditing(null);
      refresh(true);
    } catch (err) { toast(err.message, 'error'); }
  };

  const remove = async (item) => {
    try {
      await removeLibraryItem(item.id);
      toast('Removed from pipeline');
      refresh(true);
    } catch (err) { toast(err.message, 'error'); }
  };

  const playItem = (item) => {
    navigate(`/watch/${encodeURIComponent(`torrent:${item.infoHash}:${item.fileIndex ?? 0}`)}`, {
      state: { title: item.title, fileIndex: item.fileIndex ?? 0 },
    });
  };

  if (items === null) return <div className="page" style={{ paddingTop: 90 }}><Spinner label="Loading pipeline…" /></div>;

  return (
    <div className="sb-app">
      <div className="page" style={{ paddingTop: 24 }}>
        <h1 className="page-title">Pipeline</h1>
        <p className="page-sub">
          Add magnets for content you have rights to. Streams are held in server memory and warmed up for instant playback. <strong>Only add content you may legally access.</strong>
        </p>

        <form className="pipe-form" onSubmit={submit}>
          <div className="cols">
            <div className="field span2">
              <label>Magnet link or info hash</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <textarea className="textarea" style={{ minHeight: 46, flex: 1 }}
                  placeholder="magnet:?xt=urn:btih:…" value={form.magnet} onChange={set('magnet')} />
                <button type="button" className="btn btn-dark" onClick={paste} title="Paste from clipboard">
                  <ClipboardPaste size={16} />
                </button>
              </div>
            </div>
            <div className="field">
              <label>Title (used for artwork lookup)</label>
              <input className="input" placeholder="e.g. Big Buck Bunny" value={form.title} onChange={set('title')} />
            </div>
            <div className="field">
              <label>Type</label>
              <select className="select" value={form.kind} onChange={set('kind')}>
                <option value="movie">Movie</option>
                <option value="episode">TV Episode</option>
                <option value="other">Other</option>
              </select>
            </div>
            {form.kind === 'episode' && (
              <>
                <div className="field">
                  <label>Show name</label>
                  <input className="input" placeholder="e.g. The Wire" value={form.showName} onChange={set('showName')} />
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Season</label>
                    <input className="input" type="number" min="1" value={form.season} onChange={set('season')} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Episode</label>
                    <input className="input" type="number" min="1" value={form.episode} onChange={set('episode')} />
                  </div>
                </div>
              </>
            )}
          </div>
          <button className="btn btn-primary" disabled={adding || !form.magnet.trim()}>
            {adding ? 'Adding…' : 'Add to pipeline'}
          </button>
        </form>

        {items.length === 0 && (
          <EmptyState emoji="🧲" title="Pipeline empty">Add your first magnet above — it will appear here and start warming up.</EmptyState>
        )}

        {items.map((item) => {
          const live = item.live || {};
          const warmPct = live.headTargetBytes ? Math.min((live.headBytes / live.headTargetBytes) * 100, 100) : 0;
          const canPlay = live.fileIndex != null || item.fileIndex != null;
          return (
            <div className="lib-item" key={item.id}>
              <div className="lib-poster">
                <PosterImage src={item.poster} alt={item.title} />
              </div>
              <div className="lib-info">
                <div className="lib-title">
                  {item.kind === 'episode' && item.season != null
                    ? `${item.showName || item.title} · S${String(item.season).padStart(2, '0')}E${String(item.episode ?? '?').padStart(2, '0')}`
                    : item.title}
                </div>
                <div className="lib-sub">
                  <ReadyBadge state={live.readyState} />
                  <span>{item.kind}</span>
                  {live.fileName && <span title={live.fileName}>{live.fileName.slice(0, 40)}</span>}
                  {live.totalSize > 0 && <span>{formatBytes(live.totalSize)}</span>}
                  {live.containerPlayable === false && <span className="chip red" title="MKV/AVI don't stream in browsers">⚠ container</span>}
                </div>
                <div className={`warmbar ${live.readyState === 'ready' ? 'ready' : ''}`}>
                  <div className="fill" style={{ width: `${live.readyState === 'ready' ? 100 : Math.max(warmPct, 3)}%` }} />
                </div>
                <div className="speed-line">
                  {live.connected
                    ? `${formatBytes(live.headBytes || 0)} buffered · ${formatSpeed(live.downloadSpeed || 0)} · ${live.peers || 0} peers · ${Math.round((live.progress || 0) * 100)}% total`
                    : 'Connecting to peers…'}
                </div>
              </div>
              <div className="lib-actions">
                <button className="icon-btn" title={`${canPlay ? 'Play' : 'Waiting for file info'}`} disabled={!canPlay} onClick={() => playItem(item)}>
                  <Play />
                </button>
                <button className="icon-btn" title="Re-fetch artwork by keywords" onClick={() => doArtRefresh(item)}>
                  <Image />
                </button>
                <button className="icon-btn" title="Edit tags" onClick={() => setEditing({ ...item, season: item.season ?? '', episode: item.episode ?? '' })}>
                  <Pencil />
                </button>
                <button className="icon-btn danger" title="Remove" onClick={() => remove(item)}>
                  <Trash2 />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {artPick && (
        <Modal title="Pick artwork" subtitle="Choose the poster that matches your file"
          onClose={() => setArtPick(null)} wide>
          <div className="art-picks">
            {artPick.alternatives.map((alt, i) => (
              <button key={alt.id || i} className="art-pick" onClick={() => pickArt(i)} title={alt.title}>
                <PosterImage src={alt.poster} alt={alt.title} />
              </button>
            ))}
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title="Edit pipeline item" subtitle="Adjust how this file is cataloged and tracked"
          onClose={() => setEditing(null)}>
          <form onSubmit={saveEdit}>
            <div className="field">
              <label>Title</label>
              <input className="input" value={editing.title} onChange={(e) => setEditing((s) => ({ ...s, title: e.target.value }))} />
            </div>
            <div className="field">
              <label>Type</label>
              <select className="select" value={editing.kind} onChange={(e) => setEditing((s) => ({ ...s, kind: e.target.value }))}>
                <option value="movie">Movie</option>
                <option value="episode">TV Episode</option>
                <option value="other">Other</option>
              </select>
            </div>
            {editing.kind === 'episode' && (
              <>
                <div className="field">
                  <label>Show name</label>
                  <input className="input" value={editing.showName || ''} onChange={(e) => setEditing((s) => ({ ...s, showName: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Season</label>
                    <input className="input" type="number" min="1" value={editing.season} onChange={(e) => setEditing((s) => ({ ...s, season: e.target.value }))} />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Episode</label>
                    <input className="input" type="number" min="1" value={editing.episode} onChange={(e) => setEditing((s) => ({ ...s, episode: e.target.value }))} />
                  </div>
                </div>
              </>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-dark" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
