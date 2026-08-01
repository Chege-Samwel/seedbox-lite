import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Info } from 'lucide-react';
import { getHome, getHistory, getLibrary } from '../services/api';
import { useFavorites } from '../hooks/useFavorites';
import { Row, MediaCard, ReadyBadge, Spinner, EmptyState } from '../components/ui';

export default function HomePage() {
  const navigate = useNavigate();
  const [home, setHome] = useState(null);
  const [history, setHistory] = useState([]);
  const [library, setLibrary] = useState([]);
  const [loading, setLoading] = useState(true);
  const { favorites } = useFavorites();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [homeRes, histRes, libRes] = await Promise.allSettled([
        getHome(), getHistory(), getLibrary(),
      ]);
      if (cancelled) return;
      setHome(homeRes.status === 'fulfilled' ? homeRes.value : { rows: [], offline: true });
      setHistory(histRes.status === 'fulfilled' ? histRes.value.history : []);
      setLibrary(libRes.status === 'fulfilled' ? libRes.value.items : []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const continueWatching = useMemo(
    () => history.filter((h) => h.duration > 0 && h.position > 10 && h.position / h.duration < 0.9).slice(0, 10),
    [history]
  );

  const featured = useMemo(() => {
    const first = home?.rows?.find((r) => r.items?.length)?.items || [];
    // A deterministic "featured" pick, reshuffled daily
    if (!first.length) return null;
    const day = Math.floor(Date.now() / 86400000);
    return first[day % first.length];
  }, [home]);

  if (loading) {
    return <div className="page" style={{ paddingTop: 90 }}><Spinner label="Loading your cinema…" /></div>;
  }

  return (
    <div className="sb-app">
      {featured && (
        <div className="hero">
          <div className="hero-bg" style={{ backgroundImage: `url(${featured.poster})` }} />
          <div className="hero-content">
            <span className="hero-tag">● Public Domain Pick</span>
            <h1 className="hero-title">{featured.title}</h1>
            <div className="hero-meta">
              {featured.year && <span className="match">{featured.year}</span>}
              {featured.downloads > 0 && <span>{Intl.NumberFormat('en', { notation: 'compact' }).format(featured.downloads)} downloads</span>}
              <span>Internet Archive</span>
            </div>
            {featured.description && <p className="hero-desc">{featured.description.replace(/<[^>]*>/g, '').slice(0, 280)}</p>}
            <div className="hero-actions">
              <button className="btn btn-primary" onClick={() => navigate(`/title/archive/${featured.id}?autoplay=1`)}>
                <Play size={18} fill="currentColor" /> Play
              </button>
              <button className="btn btn-ghost" onClick={() => navigate(`/title/archive/${featured.id}`)}>
                <Info size={18} /> Details
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="page" style={{ paddingTop: featured ? 10 : 90 }}>
        <Row title="Continue Watching" hint="Pick up where you left off">
          {continueWatching.map((h) => (
            <MediaCard
              key={h.key}
              wide
              title={h.title}
              subtitle={h.kind === 'episode' && h.extra?.season ? `S${h.extra.season} · E${h.extra.episode}` : h.kind}
              poster={h.backdrop || h.poster}
              progress={h.duration ? h.position / h.duration : 0}
              onClick={() => {
                if (h.source.type === 'archive') navigate(`/watch/${encodeURIComponent(`archive:${h.source.identifier}:${h.source.fileIndex ?? 0}`)}`);
                else navigate(`/watch/${encodeURIComponent(`torrent:${h.source.infoHash}:${h.source.fileIndex}`)}`);
              }}
            />
          ))}
        </Row>

        <Row title="Favorites" hint="Hand-picked by you">
          {favorites.map((f) => (
            <MediaCard
              key={f.key}
              title={f.title}
              subtitle={f.kind}
              poster={f.poster}
              onClick={() => {
                if (f.ref?.type === 'archive') navigate(`/title/archive/${f.ref.id}`);
                else if (f.ref?.type === 'show') navigate(`/title/show/${encodeURIComponent(f.ref.id)}`);
                else navigate('/library');
              }}
            />
          ))}
        </Row>

        <Row title="My Pipeline" hint="Your magnet library">
          {library.map((item) => (
            <MediaCard
              key={item.id}
              title={item.title}
              subtitle={item.kind === 'episode' && item.season != null ? `${item.showName} · S${item.season}E${item.episode}` : item.kind}
              poster={item.poster}
              badge={<ReadyBadge state={item.live?.readyState} />}
              progress={item.live?.fileProgress}
              onClick={() => navigate('/library')}
            />
          ))}
        </Row>

        {(home?.rows || []).map((row) => (
          <Row key={row.key} title={row.title} hint="Internet Archive">
            {row.items.map((it) => (
              <MediaCard
                key={it.id}
                title={it.title}
                subtitle={it.year || ''}
                poster={it.poster}
                onClick={() => navigate(`/title/archive/${it.id}`)}
              />
            ))}
          </Row>
        ))}

        {home?.offline && home.rows.length === 0 && !continueWatching.length && !library.length && (
          <div style={{ paddingTop: 60 }}>
            <EmptyState emoji="📡" title="Catalog unreachable">
              The Internet Archive couldn't be reached from the server right now.
              You can still add magnets in the <strong>Pipeline</strong> tab.
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}
