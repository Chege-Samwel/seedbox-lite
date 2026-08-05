import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, Info, RotateCw, Radio } from 'lucide-react';
import { getHome, getHistory, getLibrary } from '../services/api';
import { useFavorites } from '../hooks/useFavorites';
import { Row, MediaCard, ReadyBadge, Spinner, EmptyState } from '../components/ui';

function cleanDescription(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function feedDate(item) {
  if (!item?.publishedAt) return '';
  const date = new Date(item.publishedAt);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function feedSubtitle(item) {
  const ep = item?.episodeInfo;
  if (item?.category === 'tv' && ep?.isEpisode) return `S${String(ep.season).padStart(2, '0')} · E${String(ep.episode).padStart(2, '0')} · ${feedDate(item)}`;
  if (item?.category === 'tv' && ep?.isPack) return `Season pack · ${feedDate(item)}`;
  return [item?.category === 'tv' ? 'TV show' : 'Movie', feedDate(item)].filter(Boolean).join(' · ');
}

function FeedBadge({ item }) {
  return <span className="feed-card-badge">{item.category === 'tv' ? 'TV' : 'MOVIE'}</span>;
}

export default function HomePage() {
  const navigate = useNavigate();
  const [home, setHome] = useState(null);
  const [history, setHistory] = useState([]);
  const [library, setLibrary] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const { favorites } = useFavorites();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    let localDone = false;
    const markLocalDone = () => {
      if (!localDone) { localDone = true; if (!cancelled) setLoading(false); }
    };
    getHistory()
      .then((h) => { if (!cancelled) setHistory(h.history || []); })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(markLocalDone);
    getLibrary()
      .then((l) => { if (!cancelled) setLibrary(l.items || []); })
      .catch(() => { if (!cancelled) setLibrary([]); })
      .finally(markLocalDone);
    getHome(reloadTick > 0)
      .then((h) => { if (!cancelled) setHome(h || { rows: [], offline: true }); })
      .catch(() => { if (!cancelled) setHome({ rows: [], offline: true }); });
    return () => { cancelled = true; };
  }, [reloadTick]);

  const retry = useCallback(() => setReloadTick((t) => t + 1), []);

  const continueWatching = useMemo(
    () => history.filter((h) => h.duration > 0 && h.position > 10 && h.position / h.duration < 0.9).slice(0, 10),
    [history]
  );

  const feedRows = useMemo(() => home?.rows || [], [home]);
  const featured = useMemo(() => {
    const latest = feedRows.find((row) => row.kind === 'new' && row.items?.length);
    return latest?.items?.[0] || feedRows.find((row) => row.items?.length)?.items?.[0] || null;
  }, [feedRows]);

  const openFeed = useCallback((item) => {
    if (item?.infoHash) navigate(`/title/feed/${encodeURIComponent(item.infoHash)}`);
  }, [navigate]);

  if (loading) {
    return <div className="page" style={{ paddingTop: 90 }}><Spinner label="Loading your cinema…" /></div>;
  }

  return (
    <div className="sb-app">
      {featured && (
        <div className="hero">
          <div className="hero-bg" style={{ backgroundImage: `url(${featured.backdrop || featured.poster})` }} />
          <div className="hero-content">
            <span className="hero-tag"><Radio size={13} /> {featured.category === 'tv' ? 'Latest TV show' : 'Latest movie'} · RSS catalog</span>
            <h1 className="hero-title">{featured.title}</h1>
            <div className="hero-meta">
              {featured.episodeInfo?.isEpisode && <span className="match">S{String(featured.episodeInfo.season).padStart(2, '0')}E{String(featured.episodeInfo.episode).padStart(2, '0')}</span>}
              {featured.creator && <span>by {featured.creator}</span>}
              {featured.size > 0 && <span>{(featured.size / 1073741824).toFixed(1)} GB</span>}
              <span>The Pirate Bay RSS</span>
            </div>
            {featured.overview && <p className="hero-desc">{cleanDescription(featured.overview).slice(0, 280)}</p>}
            <div className="hero-actions">
              <button className="btn btn-primary" onClick={() => openFeed(featured)}>
                <Play size={18} fill="currentColor" /> Open title
              </button>
              <button className="btn btn-ghost" onClick={() => openFeed(featured)}>
                <Info size={18} /> Episodes &amp; files
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
                if (f.ref?.type === 'rss') navigate(`/title/feed/${encodeURIComponent(f.ref.id)}`);
                else if (f.ref?.type === 'archive') navigate(`/title/archive/${f.ref.id}`);
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

        {home?.offline && (
          <div className="offline-banner">
            <span>📡 Live RSS is unavailable — showing the fixed catalog snapshot. Your title pages and pipeline still work.</span>
            <button className="btn btn-dark btn-sm" onClick={retry}><RotateCw size={13} /> Retry feeds</button>
          </div>
        )}

        {feedRows.map((row) => (
          <Row key={row.key} title={row.title} hint={row.hint}>
            {row.items.map((item) => (
              <MediaCard
                key={`${row.key}:${item.infoHash}`}
                title={item.title}
                subtitle={feedSubtitle(item)}
                poster={item.poster}
                badge={<FeedBadge item={item} />}
                onClick={() => openFeed(item)}
              />
            ))}
          </Row>
        ))}

        {feedRows.length === 0 && !continueWatching.length && !library.length && (
          <div style={{ paddingTop: 60 }}>
            <EmptyState emoji="📡" title="No catalog rows available">
              The RSS feeds could not be reached and no fixed snapshot is available.
              <div style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={retry}><RotateCw size={16} /> Retry catalog</button>
              </div>
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}
