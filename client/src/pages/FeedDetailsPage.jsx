import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, Copy, Heart, Link2, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { addToLibrary, getRssItem, getTorrentDetails } from '../services/api';
import { EmptyState, PosterImage, Spinner } from '../components/ui';
import { formatBytes } from '../utils/format';
import { useToast } from '../hooks/useToast';
import { useFavorites } from '../hooks/useFavorites';

function titleFor(item, ep) {
  if (!ep || ep.season == null) return item.title;
  return `${item.episodeInfo?.showTitle || item.title} S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
}

function fileFor(details, fileIndex) {
  return details?.files?.find((file) => file.index === fileIndex) || null;
}

export default function FeedDetailsPage() {
  const { infoHash } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { isFavorite, toggle } = useFavorites();
  const [item, setItem] = useState(null);
  const [details, setDetails] = useState(null);
  const [error, setError] = useState(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadFiles = async () => {
    if (!item || loadingFiles) return;
    setLoadingFiles(true);
    try {
      const data = await getTorrentDetails(item.infoHash);
      setDetails(data);
    } catch (err) {
      // A feed item remains useful even when metadata peers are slow. The
      // first-file card still lets the user queue it in the pipeline.
      toast(err.message || 'File list is not available yet', 'error');
    }
    setLoadingFiles(false);
  };

  useEffect(() => {
    let cancelled = false;
    setItem(null); setDetails(null); setError(null);
    getRssItem(infoHash)
      .then((data) => { if (!cancelled) setItem(data); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [infoHash]);

  useEffect(() => {
    if (item) loadFiles();
    // The file list is metadata-only; it lets season packs expose each
    // episode without starting playback or selecting a whole torrent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.infoHash]);

  const episodes = useMemo(() => details?.derived?.episodes || [], [details]);
  const videoFiles = useMemo(
    () => (details?.files || []).filter((file) => /\.(mp4|m4v|webm|ogv|mkv|avi|mov)$/i.test(file.name)),
    [details]
  );
  const subtitles = useMemo(
    () => (details?.files || []).filter((file) => /\.(srt|vtt)$/i.test(file.name)),
    [details]
  );

  const copyMagnet = async () => {
    try {
      await navigator.clipboard.writeText(item.magnet);
      setCopied(true);
      toast('Magnet copied');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Clipboard unavailable — select the magnet manually', 'error');
    }
  };

  const queueAndPlay = async (fileIndex = 0, ep = null) => {
    try {
      const episode = ep || item.episodeInfo;
      const isEpisode = item.category === 'tv' || episode?.isEpisode;
      await addToLibrary({
        magnet: item.magnet,
        kind: isEpisode ? 'episode' : 'movie',
        title: titleFor(item, ep),
        showName: isEpisode ? (item.episodeInfo?.showTitle || item.title) : undefined,
        season: ep?.season ?? episode?.season ?? undefined,
        episode: ep?.episode ?? episode?.episode ?? undefined,
        poster: item.poster,
      });
      navigate(`/watch/${encodeURIComponent(`torrent:${item.infoHash}:${fileIndex}`)}`, {
        state: {
          title: titleFor(item, ep),
          subtitle: ep?.season != null
            ? `S${String(ep.season).padStart(2, '0')} · E${String(ep.episode).padStart(2, '0')}`
            : (item.episodeInfo?.isEpisode ? `S${String(item.episodeInfo.season).padStart(2, '0')} · E${String(item.episodeInfo.episode).padStart(2, '0')}` : ''),
          kind: isEpisode ? 'episode' : 'movie',
          extra: isEpisode ? {
            season: ep?.season ?? episode?.season ?? null,
            episode: ep?.episode ?? episode?.episode ?? null,
            showKey: item.episodeInfo?.showTitle || item.title,
          } : undefined,
          fileIndex,
          magnet: item.magnet,
          poster: item.poster,
          backdrop: item.backdrop,
        },
      });
    } catch (err) {
      toast(err.message || 'Could not queue this title', 'error');
    }
  };

  if (error) return <div className="page" style={{ paddingTop: 90 }}><EmptyState emoji="📡" title="Couldn't load this feed item">{error}</EmptyState></div>;
  if (!item) return <div className="page" style={{ paddingTop: 90 }}><Spinner label="Loading RSS item…" /></div>;

  const favoriteKey = `rss:${item.infoHash}`;
  const pack = item.episodeInfo?.isPack || episodes.length > 1;
  const date = item.publishedAt ? new Date(item.publishedAt).toLocaleString() : '';

  return (
    <div>
      <div className="details-hero feed-details-hero">
        <div className="hero-bg" style={{ backgroundImage: `url(${item.backdrop || item.poster})` }} />
      </div>
      <div className="details-body">
        <PosterImage src={item.poster} alt={item.title} className="details-poster" />
        <div className="details-main feed-details-main">
          <div className="meta-line">
            <span className="chip green">{item.category === 'tv' ? 'TV SHOW' : 'MOVIE'}</span>
            <span>{item.feedKind === 'new' ? 'Latest RSS' : 'Top 100 RSS'}</span>
            {item.size > 0 && <span>{formatBytes(item.size)}</span>}
            {date && <span>{date}</span>}
          </div>
          <h1>{item.title}</h1>
          {item.episodeInfo?.isEpisode && <p className="page-sub">Episode S{String(item.episodeInfo.season).padStart(2, '0')}E{String(item.episodeInfo.episode).padStart(2, '0')} · {item.episodeInfo.showTitle}</p>}
          {item.overview && <p className="overview">{item.overview}</p>}

          <div className="details-actions">
            <button className="btn btn-primary" onClick={() => queueAndPlay(episodes[0]?.fileIndex ?? 0, episodes[0] || null)}>
              <Play size={18} fill="currentColor" /> Play {pack ? 'first file' : 'now'}
            </button>
            <button className="btn btn-dark" onClick={copyMagnet}>
              {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy magnet'}
            </button>
            <button
              className={`btn ${isFavorite(favoriteKey) ? 'btn-primary' : 'btn-ghost'}`}
              onClick={async () => {
                const added = await toggle({
                  key: favoriteKey, title: item.title, kind: item.category === 'tv' ? 'tv' : 'movie',
                  poster: item.poster, backdrop: item.backdrop,
                  ref: { type: 'rss', id: item.infoHash },
                });
                toast(added ? 'Added to favorites' : 'Removed from favorites');
              }}
            >
              <Heart size={16} fill={isFavorite(favoriteKey) ? 'currentColor' : 'none'} />
              {isFavorite(favoriteKey) ? 'Favorited' : 'Favorite'}
            </button>
            {item.comments && <a className="btn btn-ghost" href={item.comments} target="_blank" rel="noreferrer"><Link2 size={16} /> Source</a>}
          </div>

          <div className="feed-source-card">
            <div>
              <strong>RSS source</strong>
              <span>{item.feedLabel} · {item.creator ? `uploaded by ${item.creator}` : 'creator not listed'}</span>
              <span className="feed-policy">Only queue or play material you are authorized to access.</span>
            </div>
            <button className="icon-btn" onClick={copyMagnet} title="Copy magnet link">{copied ? <Check /> : <Copy />}</button>
          </div>

          {loadingFiles && (
            <div className="feed-loading"><LoaderCircle size={17} className="spin-icon" /> Inspecting the torrent file list…</div>
          )}

          {!loadingFiles && details && (episodes.length > 1 || videoFiles.length > 1) && (
            <section className="feed-files">
              <div className="row-head">
                <h2 className="row-title">{episodes.length > 1 ? 'Episodes in this torrent' : 'Video files in this torrent'}</h2>
                <span className="row-hint">one magnet · {videoFiles.length} videos · {subtitles.length} subtitle files</span>
              </div>
              <div className="feed-episode-list">
                {(episodes.length ? episodes : videoFiles.map((file) => ({ fileIndex: file.index, name: file.name }))).map((ep, index) => {
                  const file = fileFor(details, ep.fileIndex);
                  return (
                    <div className="feed-file-row" key={`${ep.fileIndex}:${ep.name}`}>
                      <div className="feed-file-index">{ep.season != null ? `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}` : String(index + 1).padStart(2, '0')}</div>
                      <div className="feed-file-copy">
                        <strong>{ep.season != null ? (ep.cleanName || ep.name) : ep.name}</strong>
                        {file?.size > 0 && <span>{formatBytes(file.size)}{file.progress > 0 ? ` · ${Math.round(file.progress * 100)}% available` : ''}</span>}
                      </div>
                      <button className="btn btn-dark btn-sm" onClick={() => queueAndPlay(ep.fileIndex, ep.season != null ? ep : null)}>
                        <Play size={14} fill="currentColor" /> Play
                      </button>
                    </div>
                  );
                })}
              </div>
              {subtitles.length > 0 && <p className="page-sub feed-subtitle-note">💬 Embedded subtitles are available in the player subtitle menu.</p>}
            </section>
          )}

          {!loadingFiles && !details && (
            <div className="feed-file-placeholder">
              <p>{item.episodeInfo?.isPack ? 'This looks like a season pack. Inspect the torrent to list each episode and its file index.' : 'The file list is not cached yet.'}</p>
              <button className="btn btn-dark btn-sm" onClick={loadFiles}><RefreshCw size={14} /> Retry file list</button>
            </div>
          )}

          {details && episodes.length <= 1 && videoFiles.length <= 1 && subtitles.length > 0 && (
            <p className="page-sub feed-subtitle-note">💬 {subtitles.length} embedded subtitle file{subtitles.length > 1 ? 's' : ''} will be available in the player.</p>
          )}
        </div>
      </div>
    </div>
  );
}
