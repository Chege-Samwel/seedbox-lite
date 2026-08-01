import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  ArrowLeft, MessageSquare, Upload, Maximize, Minimize,
  Play, Pause, Volume2, VolumeX,
} from 'lucide-react';
import {
  getArchiveItem, getSubtitleProxyUrl, getTorrentStreamUrl, getTorrentDetails,
  getTorrentSubtitleUrl, getHistoryEntry, saveHistory, getLibrary, sendStreamHeartbeat,
} from '../services/api';
import { formatTime } from '../utils/format';
import { useToast } from '../hooks/useToast';

function srtToVtt(text) {
  if (text.includes('WEBVTT')) return text;
  return 'WEBVTT\n\n' + text.replace(/\r/g, '').split('\n')
    .map((l) => (/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(l) ? l.replace(/,/g, '.') : l))
    .join('\n');
}

const CAP_SIZES = ['Small', 'Medium', 'Large'];
const CAP_CLASSES = ['cap-s', 'cap-m', 'cap-l'];
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);

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
  const scrubRef = useRef(null);
  const saveTimer = useRef(null);
  const hbTimer = useRef(null);
  const hideTimer = useRef(null);
  const lastTap = useRef(0);
  const dragging = useRef(false);

  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState(null);
  const [buffering, setBuffering] = useState(true);
  const [uiVisible, setUiVisible] = useState(true);
  const [subMenu, setSubMenu] = useState(false);
  const [tracks, setTracks] = useState([]);
  const [activeTrack, setActiveTrack] = useState(-1);
  const [resumePos, setResumePos] = useState(null);
  const [info, setInfo] = useState({ title: 'Now Playing', subtitle: '', poster: null, backdrop: null, src: null, kind: 'movie' });
  const [fs, setFs] = useState(false);

  // playback-ui state
  const [playing, setPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [hoverScrub, setHoverScrub] = useState(null); // { frac, secs }
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [flash, setFlash] = useState(null); // 'play' | 'pause'
  const [capSize, setCapSize] = useState(() => {
    const saved = parseInt(localStorage.getItem('sb_cap_size') || '1', 10);
    return CAP_CLASSES[saved] ? saved : 1;
  });

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
          const lib = await getLibrary().catch(() => ({ items: [] }));
          const item = lib.items?.find((i) => i.infoHash === identifier);
          const fileIndex = locationMeta.fileIndex ?? item?.fileIndex ?? startIndex;
          const fileName = details?.files?.[fileIndex]?.name || item?.fileName || '';
          // Embedded subtitles living inside the torrent
          const embedded = (details?.files || [])
            .filter((f) => /\.(srt|vtt)$/i.test(f.name))
            .map((f, i) => ({ id: `tor-${i}`, label: f.name, url: getTorrentSubtitleUrl(identifier, f.index) }));
          setTracks(embedded);
          setInfo({
            title: locationMeta.title || item?.title || details?.torrent?.name || 'Pipeline item',
            subtitle: item?.kind === 'episode' && item?.season != null ? `S${item.season} · E${item.episode}` : fileName,
            kind: item?.kind || 'movie',
            poster: item?.poster || null, backdrop: item?.backdrop || null,
            src: getTorrentStreamUrl(identifier, fileIndex),
            extra: item ? { season: item.season, episode: item.episode, showKey: item.showName } : undefined,
            fileIndex,
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
        ? { type: 'archive', identifier, fileUrl: info.src, fileIndex: startIndex }
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

  // ---------- Buffer-window heartbeats (torrent sources only) ----------
  useEffect(() => {
    if (loading || fatal || type !== 'torrent') return undefined;
    const beat = () => {
      const v = videoRef.current;
      if (!v) return;
      sendStreamHeartbeat(identifier, info.fileIndex ?? startIndex, v.currentTime, v.duration || 0);
    };
    beat();
    hbTimer.current = setInterval(beat, 10000);
    return () => clearInterval(hbTimer.current);
  }, [loading, fatal, type, identifier, info.fileIndex, startIndex]);

  // ---------- Subtitle track control ----------
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = i === activeTrack ? 'showing' : 'hidden';
      }
    };
    sync();
    const t = setTimeout(sync, 500);
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

  // ---------- Playback helpers ----------
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setFlash('play'); } else { v.pause(); setFlash('pause'); }
    setTimeout(() => setFlash(null), 500);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      (el.requestFullscreen || el.webkitEnterFullscreen || el.webkitRequestFullscreen)?.call(el);
    }
  }, []);

  const seekTo = useCallback((frac) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(frac * v.duration, v.duration - 0.1));
  }, []);

  // Auto-hide UI while playing
  const pokeUi = useCallback(() => {
    setUiVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused && !dragging.current) setUiVisible(false);
    }, 2800);
  }, []);

  useEffect(() => {
    pokeUi();
    return () => hideTimer.current && clearTimeout(hideTimer.current);
  }, [pokeUi]);

  // Scrubber events
  const fracFromEvent = (clientX) => {
    const rect = scrubRef.current.getBoundingClientRect();
    return Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
  };
  const onScrubMove = (e) => {
    if (!scrubRef.current || !duration) return;
    const frac = fracFromEvent(e.clientX ?? e.touches?.[0]?.clientX);
    setHoverScrub({ frac, secs: frac * duration });
    if (dragging.current) seekTo(frac);
  };
  const onScrubDown = (e) => {
    dragging.current = true;
    onScrubMove(e);
    const up = () => { dragging.current = false; pokeUi(); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointerup', up);
  };

  // Fullscreen state
  useEffect(() => {
    const onFs = () => setFs(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const v = videoRef.current;
      if (!v) return;
      switch (e.key) {
        case ' ': e.preventDefault(); togglePlay(); break;
        case 'ArrowRight': v.currentTime += 10; break;
        case 'ArrowLeft': v.currentTime -= 10; break;
        case 'f': toggleFullscreen(); break;
        case 'm': setMuted((m) => { v.muted = !m; return !m; }); break;
        default: return;
      }
      pokeUi();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, toggleFullscreen, pokeUi]);

  // Tap handling: single = toggle UI, double = fullscreen
  const onTapStage = () => {
    const now = Date.now();
    if (now - lastTap.current < 320) { toggleFullscreen(); setUiVisible(true); }
    else { uiVisible ? (videoRef.current?.paused ? null : setUiVisible(false)) : setUiVisible(true); pokeUi(); }
    lastTap.current = now;
  };

  const isDone = duration > 0 && curTime / duration > 0.98;
  const progressFrac = duration ? curTime / duration : 0;
  const bufferedFrac = duration ? bufferedEnd / duration : 0;
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
    <div className={`player-shell ${CAP_CLASSES[capSize]} ${uiVisible ? '' : 'ui-hidden'}`} onClick={onTapStage}>
      {/* Top bar */}
      <div className={`player-topbar ${uiVisible ? '' : 'hidden'}`} onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" onClick={goBack} style={{ background: 'rgba(0,0,0,0.4)' }}>
          <ArrowLeft />
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="player-title">{info.title}</div>
          {info.subtitle && <div className="player-ep">{info.subtitle}</div>}
        </div>
      </div>

      <div className="player-stage" onClick={(e) => e.stopPropagation()}>
        {loading ? (
          <div className="spinner" />
        ) : (
          <video
            ref={videoRef}
            src={info.src}
            controls={isIos} /* iOS handles custom controls poorly */
            playsInline
            crossOrigin="anonymous"
            style={{ width: '100%', height: '100%' }}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => { setBuffering(false); setPlaying(true); }}
            onCanPlay={() => setBuffering(false)}
            onPlay={() => setPlaying(true)}
            onPause={() => { setPlaying(false); setUiVisible(true); }}
            onEnded={() => { setPlaying(false); setUiVisible(true); persist(); }}
            onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
            onDurationChange={() => setDuration(videoRef.current?.duration || 0)}
            onTimeUpdate={() => {
              const v = videoRef.current;
              if (!v) return;
              setCurTime(v.currentTime);
              try {
                if (v.buffered.length) setBufferedEnd(v.buffered.end(v.buffered.length - 1));
              } catch { /* ignore */ }
            }}
            onProgress={() => {
              const v = videoRef.current;
              try {
                if (v?.buffered.length) setBufferedEnd(v.buffered.end(v.buffered.length - 1));
              } catch { /* ignore */ }
            }}
            onClick={(e) => { e.stopPropagation(); onTapStage(); }}
          >
            {tracks.map((t, i) => (
              <track key={t.id} kind="subtitles" label={t.label} src={t.url} default={i === 0 && activeTrack === 0} />
            ))}
          </video>
        )}

        {/* Center flash icon */}
        {flash && (
          <div className="player-flash" key={flash + Date.now()}>
            {flash === 'play' ? <Play size={44} fill="currentColor" /> : <Pause size={44} fill="currentColor" />}
          </div>
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
              onClick={() => { if (videoRef.current) { videoRef.current.currentTime = resumePos; videoRef.current.play(); } setResumePos(null); }}>
              Resume
            </button>
            <button className="btn btn-dark btn-sm" onClick={() => setResumePos(null)}>Start over</button>
          </div>
        )}

        {subMenu && (
          <div className="sub-menu" onClick={(e) => e.stopPropagation()}>
            <h5>Captions</h5>
            <button className={`sub-item ${activeTrack === -1 ? 'active' : ''}`} onClick={() => { setActiveTrack(-1); }}>
              Off
            </button>
            {tracks.map((t, i) => (
              <button key={t.id} className={`sub-item ${activeTrack === i ? 'active' : ''}`} onClick={() => setActiveTrack(i)}>
                💬 {t.label}
              </button>
            ))}
            {tracks.length === 0 && <div className="sub-item" style={{ color: 'var(--text-faint)', cursor: 'default' }}>No captions bundled — upload one:</div>}
            <div style={{ borderTop: '1px solid #2a3242', margin: '8px 0 4px' }} />
            <button className="sub-item" onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} /> Upload .srt / .vtt
            </button>
            <input ref={fileInputRef} type="file" accept=".srt,.vtt" style={{ display: 'none' }} onChange={uploadSub} />
            <h5 style={{ marginTop: 10 }}>Caption size</h5>
            <div style={{ display: 'flex', gap: 6, padding: '0 8px 8px' }}>
              {CAP_SIZES.map((label, i) => (
                <button key={label}
                  className={`season-tab ${capSize === i ? 'active' : ''}`}
                  style={{ padding: '5px 10px', fontSize: 11.5 }}
                  onClick={() => { setCapSize(i); localStorage.setItem('sb_cap_size', String(i)); }}>
                  {label}
                </button>
              ))}
            </div>
            <div className="buffer-hint">🪟 Server keeps ~5 min buffered around the playhead</div>
          </div>
        )}

        {/* Custom bottom control bar (desktop/Android) */}
        {!loading && !isIos && (
          <div className={`player-controls ${uiVisible ? '' : 'hidden'}`} onClick={(e) => e.stopPropagation()}>
            <div
              ref={scrubRef}
              className="scrubber"
              onPointerDown={onScrubDown}
              onPointerMove={onScrubMove}
              onPointerLeave={() => !dragging.current && setHoverScrub(null)}
              onMouseEnter={pokeUi}
            >
              <div className="scrub-track">
                <div className="scrub-buffered" style={{ width: `${bufferedFrac * 100}%` }} />
                <div className="scrub-fill" style={{ width: `${progressFrac * 100}%` }} />
                <div className="scrub-knob" style={{ left: `${progressFrac * 100}%` }} />
              </div>
              {hoverScrub && duration > 0 && (
                <div className="scrub-tip" style={{ left: `${hoverScrub.frac * 100}%` }}>
                  <span className="scrub-thumb" style={info.backdrop ? { backgroundImage: `url(${info.backdrop})` } : undefined} />
                  {formatTime(hoverScrub.secs)}
                </div>
              )}
            </div>
            <div className="controls-row">
              <button className="icon-btn ctrl" onClick={togglePlay}>
                {playing ? <Pause /> : <Play fill="currentColor" />}
              </button>
              <button
                className="icon-btn ctrl"
                onClick={() => setMuted((m) => { const nv = !m; if (videoRef.current) videoRef.current.muted = nv; return nv; })}
              >
                {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
              </button>
              <input
                type="range" className="vol-range" min="0" max="1" step="0.05" value={muted ? 0 : volume}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setVolume(val);
                  if (videoRef.current) { videoRef.current.volume = val; videoRef.current.muted = val === 0; }
                  setMuted(val === 0);
                }}
              />
              <span className="ctrl-time">
                {formatTime(curTime)} <span className="ctrl-time-dim">/ {duration ? formatTime(duration) : '…'}</span>
                {isDone && <span className="chip green" style={{ marginLeft: 8 }}>✓</span>}
              </span>
              <span style={{ flex: 1 }} />
              <button className={`icon-btn ctrl ${subMenu ? 'on' : ''}`} onClick={() => { setSubMenu((s) => !s); pokeUi(); }} title="Captions">
                <MessageSquare />
              </button>
              <button className="icon-btn ctrl" onClick={toggleFullscreen} title="Fullscreen">
                {fs ? <Minimize /> : <Maximize />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
