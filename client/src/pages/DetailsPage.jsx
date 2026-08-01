import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Play, Check, Link2, Download, Layers } from 'lucide-react';
import { getArchiveItem, getShowData, getTrackedShow, setEpisodeWatched, addToLibrary } from '../services/api';
import { Spinner, EmptyState, Modal, PosterImage } from '../components/ui';
import { formatBytes } from '../utils/format';
import { useToast } from '../hooks/useToast';

export function ArchiveDetails() {
  const { identifier } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getArchiveItem(identifier)
      .then((data) => {
        if (cancelled) return;
        setItem(data);
        if (params.get('autoplay') === '1' && data.primaryVideo) {
          navigate(`/watch/${encodeURIComponent(`archive:${identifier}`)}`, { replace: true });
        }
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [identifier]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="page" style={{ paddingTop: 90 }}><EmptyState emoji="📡" title="Couldn't load this title">{error}</EmptyState></div>;
  if (!item) return <div className="page" style={{ paddingTop: 90 }}><Spinner label="Loading title…" /></div>;

  const play = (video) => {
    const idx = video ? item.videos.indexOf(video) : 0;
    navigate(`/watch/${encodeURIComponent(`archive:${identifier}:${idx}`)}`);
  };

  return (
    <div>
      <div className="details-hero">
        <div className="hero-bg" style={{ backgroundImage: `url(${item.backdrop})` }} />
      </div>
      <div className="details-body">
        <PosterImage src={item.poster} alt={item.title} className="details-poster" />
        <div className="details-main" style={{ marginTop: -60, position: 'relative' }}>
          <h1>{item.title}</h1>
          <div className="meta-line">
            {item.year && <span className="chip green">{item.year}</span>}
            {item.creator && <span>Directed by {item.creator}</span>}
            {item.language && <span>{item.language}</span>}
            <span className="chip">Public domain · Internet Archive</span>
          </div>
          {item.description && <p className="overview">{item.description.replace(/<[^>]*>/g, '')}</p>}
          {item.subjects?.length > 0 && (
            <div className="tag-row">{item.subjects.slice(0, 8).map((s) => <span key={s} className="chip">{s}</span>)}</div>
          )}
          <div className="details-actions">
            {item.primaryVideo && (
              <button className="btn btn-primary" onClick={() => play(item.primaryVideo)}>
                <Play size={18} fill="currentColor" /> Play now
              </button>
            )}
            {item.subtitles?.length > 0 && <span className="chip green">💬 {item.subtitles.length} subtitle file{item.subtitles.length > 1 ? 's' : ''} available</span>}
          </div>

          {item.videos.length > 1 && (
            <div style={{ marginTop: 30 }}>
              <h2 className="row-title" style={{ marginBottom: 12 }}>Versions</h2>
              {item.videos.map((v) => (
                <div className="file-row" key={v.name}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="name">{v.name}</div>
                    <div className="speed-line">{v.format}{v.browserPlayable ? ' · streams in browser' : ' · not browser-streamable (MKV/AVI)'}</div>
                  </div>
                  <span className="size">{formatBytes(v.size)}</span>
                  {v.browserPlayable
                    ? <button className="btn btn-dark btn-sm" onClick={() => play(v)}><Play size={14} /> Play</button>
                    : <a className="btn btn-dark btn-sm" href={v.url} target="_blank" rel="noreferrer"><Download size={14} /> File</a>}
                </div>
              ))}
            </div>
          )}
          {item.license && <p className="page-sub" style={{ marginTop: 20 }}>License: {item.license}</p>}
        </div>
      </div>
    </div>
  );
}

export function ShowDetails() {
  const { name } = useParams();
  const toast = useToast();
  const decoded = decodeURIComponent(name);
  const [show, setShow] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [episodes, setEpisodes] = useState(null);
  const [activeSeason, setActiveSeason] = useState(null);
  const [tracked, setTracked] = useState(null);
  const [error, setError] = useState(null);
  const [attach, setAttach] = useState(null); // { season, episode, epName }
  const [magnet, setMagnet] = useState('');
  const [attaching, setAttaching] = useState(false);

  const showKey = useMemo(() => show?.id || decoded, [show, decoded]);

  useEffect(() => {
    let cancelled = false;
    setShow(null); setEpisodes(null); setSeasons([]); setActiveSeason(null);
    getShowData(decoded)
      .then(async (data) => {
        if (cancelled) return;
        if (!data.found) { setError(data.error || 'No information found for this show.'); return; }
        setShow(data.show);
        setSeasons(data.seasons || []);
        const first = data.seasons?.[0]?.number ?? 1;
        setActiveSeason(first);
        try {
          const key = data.show.id || decoded;
          const t = await getTrackedShow(key);
          if (!cancelled && t?.show) setTracked(t.show);
        } catch { /* fine */ }
        // Load episodes of first season
        const ep = await getShowData(decoded, first).catch(() => null);
        if (!cancelled) setEpisodes(ep?.episodes || []);
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [decoded]);

  const switchSeason = async (n) => {
    setActiveSeason(n);
    setEpisodes(null);
    const data = await getShowData(decoded, n).catch(() => null);
    setEpisodes(data?.episodes || []);
  };

  const isWatched = (s, e) => !!tracked?.episodes?.[`s${s}e${e}`];

  const toggleWatched = async (ep) => {
    const watched = !isWatched(ep.season, ep.number);
    try {
      const res = await setEpisodeWatched({
        showKey, showTitle: show?.title || decoded, poster: show?.poster,
        season: ep.season, episode: ep.number, watched,
      });
      setTracked(res.show);
      toast(watched ? `Marked S${ep.season}E${ep.number} as watched` : `Unmarked S${ep.season}E${ep.number}`);
    } catch { toast('Could not update tracking', 'error'); }
  };

  const submitAttach = async (e) => {
    e.preventDefault();
    if (!magnet.trim() || attaching) return;
    setAttaching(true);
    try {
      await addToLibrary({
        magnet: magnet.trim(), kind: 'episode',
        showName: show?.title || decoded,
        season: attach.season, episode: attach.episode,
        title: `${show?.title || decoded} S${String(attach.season).padStart(2, '0')}E${String(attach.episode).padStart(2, '0')}`,
        poster: show?.poster,
      });
      toast(`Episode added to pipeline — warming up`);
      setAttach(null); setMagnet('');
    } catch (err) { toast(err.message, 'error'); }
    setAttaching(false);
  };

  if (error) return <div className="page" style={{ paddingTop: 90 }}><EmptyState emoji="📺" title="Couldn't load this show">{error}</EmptyState></div>;
  if (!show) return <div className="page" style={{ paddingTop: 90 }}><Spinner label="Loading show…" /></div>;

  const watchedCount = Object.keys(tracked?.episodes || {}).length;

  return (
    <div>
      <div className="details-hero" style={{ minHeight: '38vh' }}>
        {show.backdrop && <div className="hero-bg" style={{ backgroundImage: `url(${show.backdrop})` }} />}
      </div>
      <div className="details-body">
        <PosterImage src={show.poster} alt={show.title} className="details-poster" />
        <div className="details-main" style={{ marginTop: -60, position: 'relative' }}>
          <h1>{show.title}</h1>
          <div className="meta-line">
            {show.year && <span className="chip green">{show.year}</span>}
            <span>TV Show</span>
            {show.rating > 0 && <span className="chip">★ {Number(show.rating).toFixed(1)}</span>}
            {watchedCount > 0 && <span className="chip green">✓ {watchedCount} watched</span>}
          </div>
          {show.overview && <p className="overview">{show.overview}</p>}
          <p className="page-sub" style={{ marginTop: 10 }}>
            Attach your own magnets per episode below — they'll warm up in your pipeline and track as watched.
          </p>

          <div className="season-tabs">
            {seasons.map((s) => (
              <button key={s.number} className={`season-tab ${activeSeason === s.number ? 'active' : ''}`} onClick={() => switchSeason(s.number)}>
                S{s.number} {s.episodeCount ? `· ${s.episodeCount}` : ''}
              </button>
            ))}
          </div>

          {episodes === null ? <Spinner label="Loading episodes…" /> : (
            <div className="ep-list">
              {episodes.length === 0 && <EmptyState emoji="📼" title="No episode data available" />}
              {episodes.map((ep) => (
                <div className="ep-row" key={`${ep.season}-${ep.number}`}>
                  <div className="ep-thumb">
                    <PosterImage src={ep.still || show.poster} alt={ep.name} />
                    {isWatched(ep.season, ep.number) && <span className="watched-flag">✓ WATCHED</span>}
                  </div>
                  <div className="ep-info">
                    <div className="ep-title">{ep.number}. {ep.name || `Episode ${ep.number}`}</div>
                    {ep.overview && <div className="ep-sub">{ep.overview}</div>}
                    <div className="ep-meta">{[ep.airdate, ep.runtime && `${ep.runtime} min`, ep.rating && `★ ${Number(ep.rating).toFixed(1)}`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div className="ep-actions">
                    <button className="icon-btn" title="Attach magnet to this episode" onClick={() => { setAttach({ season: ep.season, episode: ep.number, epName: ep.name }); setMagnet(''); }}>
                      <Link2 />
                    </button>
                    <button className={`icon-btn ${isWatched(ep.season, ep.number) ? 'on' : ''}`} title="Toggle watched" onClick={() => toggleWatched(ep)}>
                      <Check />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {attach && (
        <Modal title={`Attach magnet — S${attach.season} E${attach.episode}`}
          subtitle={attach.epName ? `"${attach.epName}" · the file warms up as soon as it's added` : ''}
          onClose={() => setAttach(null)}>
          <form onSubmit={submitAttach}>
            <div className="field">
              <label>Magnet link for this episode (content you have rights to)</label>
              <textarea className="textarea" value={magnet} onChange={(e) => setMagnet(e.target.value)}
                placeholder="magnet:?xt=urn:btih:…" autoFocus />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-dark" onClick={() => setAttach(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!magnet.trim() || attaching}>
                <Layers size={16} /> {attaching ? 'Adding…' : 'Add to pipeline'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
