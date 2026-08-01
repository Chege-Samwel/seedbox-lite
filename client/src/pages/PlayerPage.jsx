import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Upload, Maximize, Minimize } from 'lucide-react';
import {
  getArchiveItem, getSubtitleProxyUrl, getTorrentStreamUrl, getTorrentDetails,
  getHistoryEntry, saveHistory, getLibrary,
} from '../services/api';
import { formatTime } from '../utils/format';
import { useToast } from '../hooks/useToast';

function srtToVtt(text) {
  if (text.includes('WEBVTT')) return text;
  return 'WEBVTT\n\n' + text.replace(/\r/g, '').split('\n')
    .map((l) => (/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(l) ? l.replace(/,/g, '.') : l))
    .join('\n');
}

export default function PlayerPage() {
  const { source } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const decoded = decodeURIComponent(source);
  const [type, identifier, idxStr] = decoded.split(':');
  const startIndex = parseInt(idxStr || '0', 10) || 0;

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const saveTimer = useRef(null);

  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState(null);
  const [buffering, setBuffering] = useState(true);
  const [showTopbar, setShowTopbar] = useState(true);
  const [showSubs, setShowSubs] = useState(false);
  const [tracks, setTracks] = useState([]);
  const [activeTrack, setActiveTrack] = useState(-1); // -1 = off
  const [resumePos, setResumePos] = useState(null);
  const [info, setInfo] = useState({ title: 'Now Playing', subtitle: '', poster: null, backdrop: null, src: null, kind: 'movie' });
  const [fs, setFs] = useState(false);

  const historyKey = useMemo(
    () => (type === 'archive' ? `archive:${identifier}` : `torrent:${identifier}:${startIndex}`),
    [type, identifier, startIndex]
  );

  const locationMeta = location.state || {};

  // ---------- Load source ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (type === 'archive') {
          const item = await getArchiveItem(identifier);
          if (cancelled) return;
          const video = item.videos[startIndex] || item.primaryVideo;
          if (!video) throw new Error('No streamable video file in this archive item.');
          const subs = (item.subtitles || []).map((s, i) => ({
            id: `ia-${i}`, label: s.name, url: getSubtitleProxyUrl(item.id, s.name),
          }));
          setTracks(subs);
          setInfo({
            title: item.title, subtitle: item.year || '', kind: 'movie',
            poster: item.poster, backdrop: item.backdrop, src: video.url,
          });
        } else if (type === 'torrent') {
          const details = await getTorrentDetails(identifier).catch(() => null);
          // Find title/poster from the pipeline item if present
          const lib = await getLibrary().catch(() => ({ items: [] }));
          const item = lib.items?.find((i) => i.infoHash === identifier);
          const fileIndex = locationMeta.fileIndex ?? item?.fileIndex ?? startIndex;
          const fileName = details?.files?.[fileIndex]?.name || item?.fileName || '';
          setInfo({
            title: locationMeta.title || item?.title || details?.torrent?.name || 'Pipeline item',
            subtitle: item?.kind === 'episode' && item?.season != null ? `S${item.season} · E${item.episode}` : fileName,
            kind: item?.kind || 'movie',
            poster: item?.poster || null, backdrop: item?.backdrop || null,
            src: getTorrentStreamUrl(identifier, fileIndex),
            extra: item ? { season: item.season, episode: item.episode, showKey: item.showName } : undefined,
          });
        } else {
          throw new Error('Unknown source type');
        }
      } catch (err) {
        if (!cancelled) setFatal(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [type, identifier, startIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Resume position ----------
  useEffect(() => {
    if (loading || fatal) return;
    getHistoryEntry(historyKey)
      .then((res) => {
        const pos = res?.entry?.position;
        const dur = res?.entry?.duration;
        if (pos > 10 && (!dur || pos / dur < 0.9)) setResumePos(pos);
      })
      .catch(() => {});
  }, [loading, fatal, historyKey]);

  // ---------- Progress saving ----------
  const persist = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    saveHistory({
      key: historyKey,
      title: info.title,
      poster: info.poster, backdrop: info.backdrop, kind: info.kind,
      source: type === 'archive'
        ? { type: 'archive', identifier, fileUrl: info.src, fileIndex: startIndex, subtitles: undefined }
        : { type: 'torrent', infoHash: identifier, fileIndex: startIndex, fileName: info.subtitle },
      position: v.currentTime, duration: v.duration,
      extra: info.extra,
    }).catch(() => {});
  }, [historyKey, info, type, identifier, startIndex]);

  useEffect(() => {
    if (loading || fatal) return;
    saveTimer.current = setInterval(persist, 5000);
    const onHide = () => persist();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', persist);
    return () => {
      clearInterval(saveTimer.current);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', persist);
      persist();
    };
  }, [loading, fatal, persist]);

  // ---------- Subtitle track control ----------
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // JSX renders <track> elements; sync their modes to the selection
    const sync = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = i === activeTrack ? 'showing' : 'hidden';
      }
    };
    sync();
    const t = setTimeout(sync, 500); // after browser parses
    return () => clearTimeout(t);
  }, [activeTrack, tracks]);

  const uploadSub = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const blob = new Blob([srtToVtt(text)], { type: 'text/vtt' });
      const url = URL.createObjectURL(blob);
      setTracks((prev) => [...prev, { id: `local-${prev.length}`, label: `${file.name} (local)`, url }]);
      setActiveTrack(tracks.length);
      toast('Subtitle loaded');
    } catch { toast('Could not read subtitle file', 'error'); }
    e.target.value = '';
  };

  // ---------- UI niceties ----------
  const toggleFullscreen = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      (el.requestFullscreen || el.webkitEnterFullscreen || el.webkitRequestFullscreen)?.call(el);
    }
  }, []);

  useEffect(() => {
    const onFs = () => setFs(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
    };
  }, []);

  const lastTap = useRef(0);
  const onTapStage = () => {
    const now = Date.now();
    if (now - lastTap.current < 320) { toggleFullscreen(); setShowTopbar(true); }
    else setShowTopbar((s) => !s);
    lastTap.current = now;
  };

  const goBack = () => navigate(-1);

  if (fatal) {
    return (
      <div className="player-shell">
        <div className="center-wrap" style={{ color: '#fff' }}>
          <div style={{ fontSize: 40 }}>🎬</div>
          <p>{fatal}</p>
          <button className="btn btn-primary" onClick={goBack}>Go back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="player-shell" onClick={onTapStage}>
      <div className={`player-topbar ${showTopbar ? '' : 'hidden'}`} onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" onClick={goBack} style={{ background: 'rgba(0,0,0,0.4)' }}>
          <ArrowLeft />
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="player-title">{info.title}</div>
          {info.subtitle && <div className="player-ep">{info.subtitle}</div>}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="icon-btn" style={{ background: 'rgba(0,0,0,0.4)' }}
            onClick={() => setShowSubs((s) => !s)} title="Subtitles">
            <MessageSquare />
          </button>
          <button className="icon-btn" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={toggleFullscreen} title="Fullscreen">
            {fs ? <Minimize /> : <Maximize />}
          </button>
        </div>
      </div>

      <div className="player-stage" onClick={(e) => e.stopPropagation()}>
        {loading ? (
          <div className="spinner" />
        ) : (
          <video
            ref={videoRef}
            src={info.src}
            controls
            playsInline
            crossOrigin="anonymous"
            style={{ width: '100%', height: '100%' }}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => setBuffering(false)}
            onCanPlay={() => setBuffering(false)}
            onClick={(e) => { e.stopPropagation(); onTapStage(); }}
          >
            {tracks.map((t, i) => (
              <track key={t.id} kind="subtitles" label={t.label} src={t.url} default={i === 0 && activeTrack === 0} />
            ))}
          </video>
        )}

        {buffering && !loading && (
          <div className="buffer-overlay" onClick={(e) => e.stopPropagation()}>
            <div className="spinner" />
          </div>
        )}

        {resumePos != null && (
          <div className="resume-toast" onClick={(e) => e.stopPropagation()}>
            <span>Resume from {formatTime(resumePos)}?</span>
            <button className="btn btn-primary btn-sm"
              onClick={() => { if (videoRef.current) videoRef.current.currentTime = resumePos; setResumePos(null); }}>
              Resume
            </button>
            <button className="btn btn-dark btn-sm" onClick={() => setResumePos(null)}>Start over</button>
          </div>
        )}

        {showSubs && (
          <div className="sub-menu" onClick={(e) => e.stopPropagation()}>
            <h5>Subtitles</h5>
            <button className={`sub-item ${activeTrack === -1 ? 'active' : ''}`} onClick={() => { setActiveTrack(-1); }}>
              Off
            </button>
            {tracks.map((t, i) => (
              <button key={t.id} className={`sub-item ${activeTrack === i ? 'active' : ''}`} onClick={() => setActiveTrack(i)}>
                💬 {t.label}
              </button>
            ))}
            <div style={{ borderTop: '1px solid #2a3242', margin: '8px 0 4px' }} />
            <button className="sub-item" onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} /> Upload .srt / .vtt
            </button>
            <input ref={fileInputRef} type="file" accept=".srt,.vtt" style={{ display: 'none' }} onChange={uploadSub} />
          </div>
        )}
      </div>
    </div>
  );
}
