import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, Play, Ban } from 'lucide-react';
import { getHistory, removeHistoryEntry, clearAllHistory } from '../services/api';
import { EmptyState, Spinner } from '../components/ui';
import { formatTime } from '../utils/format';
import { useToast } from '../hooks/useToast';
import { PosterImage } from '../components/ui';

export default function HistoryPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [history, setHistory] = useState(null);

  const load = useCallback(() => {
    getHistory().then((d) => setHistory(d.history)).catch(() => setHistory([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const { continueWatching, watched } = useMemo(() => {
    const items = history || [];
    return {
      continueWatching: items.filter((h) => h.duration > 0 && h.position / h.duration < 0.9),
      watched: items.filter((h) => h.duration > 0 && h.position / h.duration >= 0.9),
    };
  }, [history]);

  const play = (h) => {
    const src = h.source.type === 'archive'
      ? `archive:${h.source.identifier}:${h.source.fileIndex ?? 0}`
      : `torrent:${h.source.infoHash}:${h.source.fileIndex ?? 0}`;
    navigate(`/watch/${encodeURIComponent(src)}`);
  };

  const remove = async (e, key) => {
    e.stopPropagation();
    await removeHistoryEntry(key).catch(() => toast('Could not remove', 'error'));
    load();
  };

  const clear = async () => {
    await clearAllHistory().catch(() => toast('Could not clear', 'error'));
    toast('History cleared');
    load();
  };

  if (history === null) return <div className="page" style={{ paddingTop: 90 }}><Spinner label="Loading history…" /></div>;

  const Section = ({ title, items }) => items.length > 0 && (
    <>
      <h2 className="row-title" style={{ margin: '26px 0 12px' }}>{title}</h2>
      {items.map((h) => (
        <div className="hist-item" key={h.key} onClick={() => play(h)}>
          <div className="hist-thumb">
            <PosterImage src={h.backdrop || h.poster} alt={h.title} />
            {h.duration > 0 && (
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.min((h.position / h.duration) * 100, 100)}%` }} />
              </div>
            )}
          </div>
          <div className="lib-info">
            <div className="lib-title">{h.title}</div>
            <div className="lib-sub">
              <span>{h.kind === 'episode' ? 'Episode' : h.kind}</span>
              {h.source.type === 'archive' ? <span>Internet Archive</span> : <span>Pipeline</span>}
              <span>{new Date(h.updatedAt).toLocaleDateString()}</span>
              {h.duration > 0 && <span>{formatTime(h.position)} / {formatTime(h.duration)}</span>}
            </div>
          </div>
          <div className="lib-actions">
            <button className="icon-btn" title="Resume" onClick={(e) => { e.stopPropagation(); play(h); }}><Play /></button>
            <button className="icon-btn danger" title="Remove from history" onClick={(e) => remove(e, h.key)}><Trash2 /></button>
          </div>
        </div>
      ))}
    </>
  );

  return (
    <div className="sb-app">
      <div className="page" style={{ paddingTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 className="page-title" style={{ flex: 1 }}>History</h1>
          {history.length > 0 && (
            <button className="btn btn-danger btn-sm" onClick={clear}><Ban size={14} /> Clear all</button>
          )}
        </div>
        <p className="page-sub">Everything you watched, with resume points saved every 5 seconds</p>

        {history.length === 0 && <EmptyState emoji="🕰️" title="Nothing watched yet">Your watched titles and resume points will appear here.</EmptyState>}

        <Section title="Continue watching" items={continueWatching} />
        <Section title="Watched" items={watched} />
      </div>
    </div>
  );
}
