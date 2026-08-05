import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  ArrowLeft, MessageSquare, Upload, Maximize, Minimize,
  Play, Pause, Volume2, VolumeX, PictureInPicture2, RotateCw, Settings,
} from 'lucide-react';
import {
  getArchiveItem, getSubtitleProxyUrl, getArchiveStreamProxyUrl, getTorrentStreamUrl, getTorrentDetails,
  getTorrentSubtitleUrl, getHistoryEntry, saveHistory, getLibrary, sendStreamHeartbeat,
  startWarmup, getTranscodeStatus, getTranscodeUrl,
} from '../services/api';
import { formatTime, formatBytes, formatSpeed } from '../utils/format';
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
const WARM_POLL_MS = 1500;
const WARM_POLL_STALLED_MS = 4000; // dead swarm → poll gently (and cooler)
const WARM_GIVE_UP_MS = 150000; // 2.5 min of polling before offering manual retry
const RECONNECT_MAX = 8; // consecutive auto-reconnects before falling back to the warmup gate
const STALL_WATCHDOG_MS = 15000; // mid-play starve this long ⇒ reattach at playhead
const EARLY_PLAY_MIN_BYTES = 2 * 1024 * 1024; // contiguous bytes before "Play now" unlocks

/** Is a time position already covered by buffered ranges? (avoids flashing
 *  the buffering overlay for instant in-buffer seeks) */
function isCovered(v, t) {
  try {
    if (!v || !v.buffered || !v.buffered.length) return false;
    for (let i = 0; i < v.buffered.length; i++) {
      if (t >= v.buffered.start(i) - 0.25 && t <= v.buffered.end(i) + 0.25) return true;
    }
  } catch { /* ignore */ }
  return false;
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
  const scrubRef = useRef(null);
  const saveTimer = useRef(null);
  const hbTimer = useRef(null);
  const hideTimer = useRef(null);
  const lastTap = useRef(0);
  const dragging = useRef(false);
  const scrubRaf = useRef(null);
  const lastTimePush = useRef(0);
  const lastUiPoke = useRef(0);
  const warmPollTimer = useRef(null);
  const warmStartedAt = useRef(0);
  const lastSeekWarm = useRef(0);
  const pendingSeek = useRef(null);
  const generation = useRef(0); // cancels stale async runs on re-entry/unmount
  const archiveProxied = useRef(false); // already fell back to the IA stream proxy?
  const archiveProxyUrl = useRef(null); // prepared at load for the error path
  // Auto-reconnect machinery: a timeout/5xx/stream-drop must NEVER leave a
  // dead player behind. We retry in place (resume at the playhead) with
  // exponential backoff, and only fall back to the full warmup gate after
  // several consecutive failures.
  const reconnects = useRef(0);
  const reconnectTimer = useRef(null);
  const stallTimer = useRef(null);
  const playedAnyRef = useRef(false); // did THIS attach produce playback yet?
  const wantPlayRef = useRef(false);  // play() owed to the next canplay

  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState(null);
  const [buffering, setBuffering] = useState(true);
  const [uiVisible, setUiVisible] = useState(true);
  const [subMenu, setSubMenu] = useState(false);
  const [tracks, setTracks] = useState([]);
  const [activeTrack, setActiveTrack] = useState(-1);
  const [resumeNote, setResumeNote] = useState(null); // resumed position toast
  const [info, setInfo] = useState({ title: 'Now Playing', subtitle: '', poster: null, backdrop: null, src: null, kind: 'movie' });
  const [fs, setFs] = useState(false);
  const [srcKey, setSrcKey] = useState(0); // bump to force <video> remount on retry

  // Warmup gating (torrent sources only)
  const [phase, setPhase] = useState('play'); // 'play' (archive: play immediately) | 'warming' | 'ready'
  const [warm, setWarm] = useState(null); // last warmup status payload
  const [warmError, setWarmError] = useState(null);
  const [connNote, setConnNote] = useState(null); // auto-reconnect status line for overlays
  // Autoplay-with-sound can be denied after the warmup gate (the user's
  // click gesture expired while buffering). We then play muted and show a
  // one-tap "sound is off" hint instead of silently staying silent.
  const [soundBlocked, setSoundBlocked] = useState(false);
  const soundBlockedRef = useRef(false);
  const setSoundBlockedBoth = useCallback((v) => { soundBlockedRef.current = v; setSoundBlocked(v); }, []);
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  const warmRef = useRef(null); // latest warmup payload, for timers/errors
  const setWarmBoth = (st) => { warmRef.current = st; setWarm(st); };
  const earlyPlayRef = useRef(false); // user started playback before the full warm window
  const warmStartPosRef = useRef(0);  // position the warmup window is centered on

  // Quality / transcode (torrent sources only)
  const [tcMenu, setTcMenu] = useState(false);
  const [tcStatus, setTcStatus] = useState(null); // { available, presets, defaultQuality }
  const [qualityPref, setQualityPref] = useState(() => localStorage.getItem('sb_quality') || 'auto');
  const [transcodeQ, setTranscodeQ] = useState(null); // active rendition e.g. '720p' (null = direct)
  const transcodeRef = useRef(null); // mirrors transcodeQ for async paths
  const qualityRef = useRef(qualityPref);
  const playableRef = useRef(true); // source container playability
  const tcAvailRef = useRef(false);
  const tcDefaultRef = useRef('720p');

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
  const magnetRef = useRef(locationMeta.magnet || null);
  const durRef = useRef(0);
  const fileIdxRef = useRef(locationMeta.fileIndex ?? startIndex);
  const curTimeRef = useRef(0); // mirrors curTime for async paths (retry/onError)
  const resumeTarget = useRef(0); // position to seek to once the gate opens

  // ---------- Warming helpers ----------
  /** Play with sound; if the browser refuses (the warmup gate consumed the
   *  user gesture), fall back to muted autoplay + a one-tap audio hint. */
  const safePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.play().catch((err) => {
      const blocked = !!(err && (err.name === 'NotAllowedError' || /autoplay|user gesture|play\(\)/i.test(err.message || '')));
      if (!blocked || v.muted) return;
      v.muted = true;
      setSoundBlockedBoth(true);
      v.play().catch(() => { /* controls remain available */ });
    });
  }, [setSoundBlockedBoth]);

  const applyReady = useCallback((v, startPos) => {
    if (!v) return;
    // Transcoded streams are already positioned at startPos via -ss/-output_ts_offset
    if (!transcodeRef.current && startPos > 1 && v.duration && startPos < v.duration - 0.5) {
      if (v.readyState >= 1) {
        try { v.currentTime = startPos; } catch { /* fine */ }
      } else {
        pendingSeek.current = startPos;
      }
    }
    safePlay();
    if (startPos > 10) {
      setResumeNote(startPos);
      setTimeout(() => setResumeNote((n) => (n === startPos ? null : n)), 6000);
    }
  }, [safePlay]);

  // ---------- Transcode (quality variants) ----------
  const setTranscodeBoth = (q) => { transcodeRef.current = q; setTranscodeQ(q); };

  const resolveMode = useCallback((playable) => {
    const pref = qualityRef.current;
    const avail = !!tcAvailRef.current;
    if (pref === 'source') return { mode: 'direct' };
    if (avail && pref !== 'auto') return { mode: 'transcode', q: pref };
    if (avail && !playable) return { mode: 'transcode', q: tcDefaultRef.current || '720p' };
    return { mode: 'direct' };
  }, []);

  /** Point the <video> at a transcode rendition rendering from t (absolute film secs). */
  const attachTranscode = useCallback((tSecs = 0) => {
    const q = transcodeRef.current || '720p';
    if (durRef.current) setDuration(durRef.current);
    setInfo((i) => ({ ...i, src: getTranscodeUrl(identifier, fileIdxRef.current, q, tSecs) }));
    setSrcKey((k) => k + 1);
    setBuffering(true);
  }, [identifier]);

  /** Kick a warmup window at a position (fire-and-forget; errors ignored here). */
  const warmAt = useCallback((secs, { force = false } = {}) => {
    if (type !== 'torrent') return;
    const now = Date.now();
    if (!force && now - lastSeekWarm.current < 800) return; // debounce scrub spam
    lastSeekWarm.current = now;
    startWarmup(identifier, {
      magnet: magnetRef.current || undefined,
      fileIdx: fileIdxRef.current,
      positionSecs: Math.max(0, secs || 0),
      durationSecs: durRef.current || undefined,
      windowSecs: 60,
    }).then((st) => {
      if (st?.fileIndex != null) fileIdxRef.current = st.fileIndex;
      setWarmBoth(st);
    }).catch(() => { /* status polling path reports real failures */ });
  }, [type, identifier]);

  /** Re-attach the stream in place at the playhead (transcode: fresh -ss URL). */
  const reattachAt = useCallback((posSecs, { bust = false } = {}) => {
    playedAnyRef.current = false;
    wantPlayRef.current = true;
    if (durRef.current) setDuration(durRef.current);
    if (transcodeRef.current) {
      attachTranscode(posSecs);
    } else {
      pendingSeek.current = posSecs;
      const base = getTorrentStreamUrl(identifier, fileIdxRef.current);
      setInfo((i) => ({ ...i, src: bust ? `${base}&r=${Date.now()}` : base }));
      setSrcKey((k) => k + 1);
    }
    setBuffering(true);
  }, [identifier, attachTranscode]);

  /** Schedule an in-place auto-reconnect with exponential backoff.
   *  A timeout/503/dropped socket must never leave a dead player behind. */
  const scheduleReconnect = useCallback((why) => {
    if (type !== 'torrent') return;
    // The swarm guard convicted this source of feeding corrupt data:
    // reattaching is futile — go straight to the gate which spells it out.
    if (warmRef.current?.poisoned) {
      reconnects.current = 0;
      retryWarmup();
      return;
    }
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (stallTimer.current) { clearTimeout(stallTimer.current); stallTimer.current = null; }
    const n = reconnects.current + 1;
    reconnects.current = n;
    // If this attach never produced playback, the data plane (swarm), not
    // the socket, is the problem — don't burn all attempts on blind
    // reattaches; go back through the warmup gate instead.
    const cap = playedAnyRef.current ? RECONNECT_MAX : 3;
    if (n > cap) {
      reconnects.current = 0;
      setConnNote(null);
      setWarmError('Stream kept dropping — re-warming the buffer.');
      retryWarmup();
      return;
    }
    const delay = Math.min(1000 * 2 ** Math.min(n - 1, 4), 15000);
    const gen = generation.current;
    setConnNote(`${why} — reconnecting in ${Math.max(1, Math.round(delay / 1000))}s · attempt ${n}/${cap}`);
    setBuffering(true);
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      if (generation.current !== gen) return;
      const pos = curTimeRef.current || videoRef.current?.currentTime || 0;
      warmAt(pos, { force: true }); // re-center the server window on the playhead
      reattachAt(pos, { bust: true });
    }, delay);
  }, [type, warmAt, reattachAt]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The gated start: warm ~1 minute from the resume/start position, poll
   * until ready, THEN attach the stream and play. Works no matter how the
   * user got here — first play, exit & re-click, gi Server restart.
   */
  const beginWarmup = useCallback(async (gen, magnet, fileIndex, startPos) => {
    setPhase('warming');
    setWarmError(null);
    earlyPlayRef.current = false;
    warmStartPosRef.current = startPos || 0;
    warmStartedAt.current = Date.now();
    const pollOnce = async () => {
      try {
        const st = await startWarmup(identifier, {
          magnet: magnet || undefined,
          fileIdx: fileIndex,
          positionSecs: startPos || 0,
          durationSecs: durRef.current || undefined,
          windowSecs: 60,
        });
        if (generation.current !== gen) return;
        if (st?.fileIndex != null) {
          fileIdxRef.current = st.fileIndex;
        } else {
          st.fileIndex = fileIndex;
        }
        setWarmBoth(st);
        if (st.state === 'ready') {
          // The user already started playback early (Play now button) — the
          // stream is live and the governor owns the window, so don't
          // re-attach and restart the <video>; just keep status fresh.
          if (earlyPlayRef.current && phaseRef.current !== 'warming') {
            return;
          }
          resumeTarget.current = startPos || 0; // applied on first canplay
          playableRef.current = st.containerPlayable !== false;
          playedAnyRef.current = false; // this attach is unproven until it plays
          const { mode, q } = resolveMode(st.containerPlayable !== false);
          setPhase('ready');
          if (mode === 'transcode') {
            setTranscodeBoth(q);
            attachTranscode(startPos || 0);
          } else {
            setTranscodeBoth(null);
            setInfo((i) => ({ ...i, src: getTorrentStreamUrl(identifier, fileIdxRef.current), fileIndex: fileIdxRef.current }));
            setSrcKey((k) => k + 1);
          }
          return; // video 'canplay' event calls applyReady
        }
        if (Date.now() - warmStartedAt.current > WARM_GIVE_UP_MS || st?.poisoned) {
          setWarmError(st?.poisoned
            ? 'This source is poisonous (corrupt data on purpose). It will never play — go back and choose another source.'
            : (st?.stalled
              ? 'This swarm is not sending data (it may be dead or a fake). You can keep waiting or go back and pick another source.'
              : 'Taking much longer than usual — the swarm may be slow. You can keep waiting or retry.'));
        }
        // Dead/poisoned swarm? Poll gently — same liveness, a fraction of the CPU.
        const nextDelay = (st?.stalled || st?.poisoned) ? WARM_POLL_STALLED_MS : WARM_POLL_MS;
        warmPollTimer.current = setTimeout(() => { void pollOnce(); }, nextDelay);
      } catch (err) {
        if (generation.current !== gen) return;
        setWarmError(err.message || 'Warmup request failed');
        warmPollTimer.current = setTimeout(() => { void pollOnce(); }, WARM_POLL_MS * 2);
      }
    };
    await pollOnce();
  }, [identifier, attachTranscode, resolveMode]);

  /** Start playback with the data already buffered instead of waiting for the
   *  whole ~1-minute warm window ("Play now" in the warmup gate). Direct-
   *  playable containers only; the buffer keeps growing while playing. */
  const playEarly = useCallback(() => {
    if (type !== 'torrent') return;
    const st = warmRef.current || {};
    if (st.poisoned || st.containerPlayable === false || (st.bufferedFromPos || 0) < EARLY_PLAY_MIN_BYTES) return;
    earlyPlayRef.current = true;
    const startPos = warmStartPosRef.current;
    resumeTarget.current = startPos;
    playableRef.current = true;
    playedAnyRef.current = false; // this attach is unproven until it plays
    const { mode, q } = resolveMode(true);
    setPhase('ready');
    if (mode === 'transcode') {
      setTranscodeBoth(q);
      attachTranscode(startPos);
    } else {
      setTranscodeBoth(null);
      setInfo((i) => ({ ...i, src: getTorrentStreamUrl(identifier, fileIdxRef.current), fileIndex: fileIdxRef.current }));
      setSrcKey((k) => k + 1);
    }
    setConnNote(null);
  }, [type, identifier, attachTranscode, resolveMode]);

  // ---------- Load source ----------
  useEffect(() => {
    const gen = ++generation.current;
    let cancelled = false;
    (async () => {
      try {
        if (type === 'archive') {
          const item = await getArchiveItem(identifier);
          if (cancelled || generation.current !== gen) return;
          const video = item.videos[startIndex] || item.primaryVideo;
          if (!video) throw new Error('No streamable video file in this archive item.');
          const subs = (item.subtitles || []).map((s, i) => ({
            id: `ia-${i}`, label: s.name, url: getSubtitleProxyUrl(item.id, s.name),
          }));
          setTracks(subs);
          archiveProxied.current = false;
          archiveProxyUrl.current = getArchiveStreamProxyUrl(identifier, video.name);
          setInfo({
            title: item.title, subtitle: item.year || '', kind: 'movie',
            poster: item.poster, backdrop: item.backdrop, src: video.url,
          });
          setPhase('play');
        } else if (type === 'torrent') {
          // Everything is best-effort: details may 404 after a restart/reap,
          // the library always has our magnet though.
          const [tc, details, lib, hist] = await Promise.all([
            getTranscodeStatus().catch(() => null),
            getTorrentDetails(identifier).catch(() => null),
            getLibrary().catch(() => ({ items: [] })),
            getHistoryEntry(historyKey).catch(() => null),
          ]);
          if (tc) {
            tcAvailRef.current = !!tc.available;
            if (tc.defaultQuality) tcDefaultRef.current = tc.defaultQuality;
            setTcStatus(tc);
          }
          if (cancelled || generation.current !== gen) return;
          const item = lib.items?.find((i) => i.infoHash === identifier);
          magnetRef.current = magnetRef.current || item?.magnet || null;

          // Where do we start? Auto-resume (Netflix-style), else 0.
          const pos = hist?.entry?.position;
          const dur = hist?.entry?.duration;
          const startPos = pos > 10 && (!dur || pos / dur < 0.9) ? pos : 0;
          if (dur > 0) durRef.current = dur;

          const fileIndex = locationMeta.fileIndex ?? item?.fileIndex
            ?? details?.derived?.episodes?.[0]?.fileIndex ?? startIndex;
          fileIdxRef.current = fileIndex;

          const fileName = details?.files?.[fileIndex]?.name || item?.fileName || '';
          // Title: user-set > derived-from-file-names (series shared part) > magnet name
          const derivedTitle = details?.derived?.title;
          const title = (item && !item.titleAuto && item.title) || locationMeta.title
            || derivedTitle || item?.title || details?.torrent?.name || 'Pipeline item';

          const embedded = (details?.files || [])
            .filter((f) => /\.(srt|vtt)$/i.test(f.name))
            .map((f, i) => ({ id: `tor-${i}`, label: f.name, url: getTorrentSubtitleUrl(identifier, f.index) }));
          setTracks(embedded);
          setInfo({
            title,
            subtitle: item?.kind === 'episode' && item?.season != null
              ? `S${item.season} · E${item.episode ?? '?'}`
              : (fileName || derivedTitle || ''),
            kind: item?.kind || (details?.derived?.isSeries ? 'episode' : 'movie'),
            poster: item?.poster || null, backdrop: item?.backdrop || null,
            src: null, // attached on warmup ready
            extra: item ? { season: item.season, episode: item.episode, showKey: item.showName } : undefined,
            fileIndex,
          });
          await beginWarmup(gen, magnetRef.current, fileIndex, startPos);
        } else {
          throw new Error('Unknown source type');
        }
      } catch (err) {
        if (!cancelled && generation.current === gen) setFatal(err.message);
      } finally {
        if (!cancelled && generation.current === gen) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (warmPollTimer.current) clearTimeout(warmPollTimer.current);
      if (stallTimer.current) clearTimeout(stallTimer.current);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [type, identifier, startIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const retryWarmup = useCallback(() => {
    const gen = ++generation.current;
    // Full reset of the auto-reconnect machinery: the gate is authoritative now.
    reconnects.current = 0;
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    if (stallTimer.current) { clearTimeout(stallTimer.current); stallTimer.current = null; }
    setConnNote(null);
    setFatal(null);
    setLoading(false);
    setWarmBoth(null);
    // Prefer the mirrored playhead: the <video> element may already be
    // unmounted or reset to 0 after an error, losing the resume position.
    beginWarmup(gen, magnetRef.current, fileIdxRef.current, curTimeRef.current || videoRef.current?.currentTime || 0);
  }, [beginWarmup]);

  // ---------- Progress saving ----------
  const persist = useCallback(() => {
    const v = videoRef.current;
    const dur = durRef.current || v?.duration || 0; // fMP4 yields Infinity; durRef knows the truth
    if (!v || !dur || !isFinite(dur)) return;
    saveHistory({
      key: historyKey,
      title: info.title,
      poster: info.poster, backdrop: info.backdrop, kind: info.kind,
      source: type === 'archive'
        ? { type: 'archive', identifier, fileUrl: info.src, fileIndex: startIndex }
        : { type: 'torrent', infoHash: identifier, fileIndex: info.fileIndex ?? startIndex, fileName: info.subtitle },
      position: v.currentTime, duration: dur,
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
    if (soundBlockedRef.current) {
      // First tap while sound-blocked restores audio instead of toggling
      v.muted = false;
      setMuted(false);
      setSoundBlockedBoth(false);
      v.play().catch(() => {});
      setFlash('play');
    } else if (v.paused) { v.play(); setFlash('play'); } else { v.pause(); setFlash('pause'); }
    setTimeout(() => setFlash(null), 500);
  }, [setSoundBlockedBoth]);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      } else if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) {
        v.webkitSetPresentationMode(
          v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'
        );
      } else {
        toast('Picture-in-picture not supported on this browser', 'error');
      }
    } catch { toast('Could not toggle picture-in-picture', 'error'); }
  }, [toast]);

  const toggleFullscreen = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    } else {
      (el.requestFullscreen || el.webkitEnterFullscreen || el.webkitRequestFullscreen)?.call(el);
    }
  }, []);

  // ---------- Go-to-time ----------
  // Refined: snap the playhead, show the buffering state right away, and
  // re-arm the server's ~1-minute window AT the target so playback resumes
  // as soon as that minute is buffered (fast-forward behaves the same).
  /** Switch rendition / source mode at the current time (quality menu). */
  const pickQuality = useCallback((pref) => {
    setQualityPref(pref);
    qualityRef.current = pref;
    localStorage.setItem('sb_quality', pref);
    setTcMenu(false);
    if (type !== 'torrent') return;
    const { mode, q } = resolveMode(playableRef.current);
    const current = videoRef.current?.currentTime || curTimeRef.current || 0;
    if (mode === 'transcode') {
      if (transcodeRef.current === q) return; // same rendition already
      setTranscodeBoth(q);
      warmAt(current, { force: true });
      attachTranscode(current);
    } else if (transcodeRef.current) {
      // Back to the original file
      setTranscodeBoth(null);
      warmAt(current, { force: true });
      resumeTarget.current = current;
      setInfo((i) => ({ ...i, src: getTorrentStreamUrl(identifier, fileIdxRef.current) }));
      setSrcKey((k) => k + 1);
      setBuffering(true);
    }
  }, [type, attachTranscode, warmAt, identifier, resolveMode]);

  const performSeek = useCallback((secs) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const target = Math.max(0, Math.min(secs, (v.duration === Infinity ? durRef.current || v.duration : v.duration) - 0.1));
    setCurTime(target);
    curTimeRef.current = target;
    setBufferedEnd(0);
    if (!isCovered(v, target)) setBuffering(true);
    if (type === 'torrent') {
      warmAt(target, { force: true });
      if (transcodeRef.current) {
        attachTranscode(target); // ffmpeg restarts at -ss target; clock stays absolute
        return;
      }
    }
    try { v.currentTime = target; } catch { /* fine */ }
  }, [type, warmAt, attachTranscode]);

  const seekTo = useCallback((frac) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    performSeek(frac * v.duration);
  }, [performSeek]);

  // Auto-hide UI while playing — mouse MOVEMENT (or any pointer activity)
  // always brings navigation back; no click needed.
  const pokeUi = useCallback(() => {
    const now = performance.now();
    const wasHidden = !uiVisibleRef.current;
    uiVisibleRef.current = true;
    if (wasHidden || now - lastUiPoke.current > 400) {
      lastUiPoke.current = now;
      setUiVisible(true);
    }
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      uiVisibleRef.current = false;
      if (videoRef.current && !videoRef.current.paused && !dragging.current) setUiVisible(false);
    }, 2800);
  }, []);

  const uiVisibleRef = useRef(uiVisible);
  useEffect(() => { uiVisibleRef.current = uiVisible; }, [uiVisible]);

  useEffect(() => {
    pokeUi();
    return () => hideTimer.current && clearTimeout(hideTimer.current);
  }, [pokeUi]);

  const onShellPointerMove = useCallback((e) => {
    // Touch taps are handled by onTapStage; mouse/pen movement = poke
    if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    pokeUi();
  }, [pokeUi]);

  // Scrubber events — rAF-throttled so hover feels silk-smooth even at
  // 120Hz pointer rates
  const fracFromEvent = (clientX) => {
    const rect = scrubRef.current.getBoundingClientRect();
    return Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
  };
  const pendingFrac = useRef(null);
  const onScrubMove = (e) => {
    if (!scrubRef.current || !duration) return;
    pendingFrac.current = fracFromEvent(e.clientX ?? e.touches?.[0]?.clientX);
    if (scrubRaf.current) return;
    scrubRaf.current = requestAnimationFrame(() => {
      scrubRaf.current = null;
      const frac = pendingFrac.current;
      if (frac == null) return;
      setHoverScrub({ frac, secs: frac * duration });
      if (dragging.current) {
        // Live-preview the knob while dragging; the real seek + warmup
        // fires on pointer-up (scrub spam would hammer the server).
        setCurTime(frac * duration);
      }
    });
  };
  const onScrubDown = (e) => {
    dragging.current = true;
    onScrubMove(e);
    const up = (ev) => {
      dragging.current = false;
      pokeUi();
      window.removeEventListener('pointerup', up);
      if (scrubRef.current && duration) {
        const clientX = ev.clientX ?? ev.changedTouches?.[0]?.clientX;
        if (clientX != null) seekTo(fracFromEvent(clientX));
      }
    };
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
        case 'ArrowRight': performSeek((v.currentTime || 0) + 10); break;
        case 'ArrowLeft': performSeek(Math.max(0, (v.currentTime || 0) - 10)); break;
        case 'f': toggleFullscreen(); break;
        case 'm': { const nm = !v.muted; v.muted = nm; setMuted(nm); if (!nm) setSoundBlockedBoth(false); break; }
        default: return;
      }
      pokeUi();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, toggleFullscreen, pokeUi, performSeek, setSoundBlockedBoth]);

  // Tap handling: single = toggle UI, double = fullscreen. A tap while
  // sound-blocked restores audio first (the autoplay fallback muted it).
  const onTapStage = () => {
    if (soundBlockedRef.current) {
      const v = videoRef.current;
      if (v) { v.muted = false; setMuted(false); setSoundBlockedBoth(false); v.play().catch(() => {}); }
      pokeUi();
      return;
    }
    const now = Date.now();
    if (now - lastTap.current < 320) { toggleFullscreen(); setUiVisible(true); }
    else { uiVisible ? (videoRef.current?.paused ? null : setUiVisible(false)) : setUiVisible(true); pokeUi(); }
    lastTap.current = now;
  };

  const isDone = duration > 0 && curTime / duration > 0.98;
  const progressFrac = duration ? curTime / duration : 0;
  const bufferedFrac = duration ? bufferedEnd / duration : 0;
  const goBack = () => navigate(-1);
  const warming = type === 'torrent' && phase === 'warming' && !fatal;

  if (fatal) {
    return (
      <div className="player-shell">
        <div className="center-wrap" style={{ color: '#fff' }}>
          <div style={{ fontSize: 40 }}>🎬</div>
          <p>{fatal}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            {type === 'torrent' && (
              <button className="btn btn-primary" onClick={retryWarmup}>
                <RotateCw size={16} /> Retry
              </button>
            )}
            <button className="btn btn-dark" onClick={goBack}>Go back</button>
          </div>
        </div>
      </div>
    );
  }

  // Status line while gating on warmup
  const warmLine = (() => {
    if (!warming) return '';
    const st = warm || {};
    if (warmError && !st.state) return warmError;
    const parts = [];
    if (st.state === 'loading' || st.state === 'missing') {
      parts.push(st.state === 'missing' ? 'Waking the torrent…' : 'Connecting to peers & fetching metadata…');
      if (st.state === 'missing' && !magnetRef.current) parts.push('no magnet on record — add it again if this persists');
    } else if (st.state === 'connecting') {
      parts.push('Connected — starting buffer…');
    } else {
      if (st.poisoned) {
        parts.push('⛔ This swarm is feeding CORRUPT data (pieces fail verification) — the server throttled it to protect itself and the other tabs. Playback can\'t recover; pick another source.');
      } else if (st.stalled) {
        parts.push(st.stalledReason === 'no-peers'
          ? '⏸ No peers sending data — this swarm looks dead or unreachable. Holding the slot and retrying…'
          : '⏸ Peers connected but no data is flowing — the swarm may be dead or fake. Still trying…');
      }
      const got = formatBytes(st.bufferedFromPos || 0);
      const want = formatBytes(st.targetBytes || 0);
      parts.push(`Buffering the first minute — ${got} / ${want}`);
      if (st.speed > 0) parts.push(`${formatSpeed(st.speed)}${st.etaSecs != null && st.etaSecs < 600 ? ` · ~${Math.ceil(st.etaSecs)}s` : ''}`);
      parts.push(`${st.peers || 0} peers`);
    }
    return parts.filter(Boolean).join(' · ');
  })();

  return (
    <div
      className={`player-shell ${CAP_CLASSES[capSize]} ${uiVisible ? '' : 'ui-hidden'}`}
      onClick={onTapStage}
      onPointerMove={onShellPointerMove}
      onMouseMove={onShellPointerMove}
    >
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
        ) : info.src ? (
          <video
            key={srcKey}
            ref={videoRef}
            src={info.src}
            controls={isIos} /* iOS handles custom controls poorly */
            playsInline
            // metadata-only preload: fetch the moov header, never the whole
            // file (the server's warmup window owns what gets downloaded).
            preload="metadata"
            // Android TV / Android WebView inline playback (UC / X5 / TV
            // browsers otherwise hijack fullscreen or play in a popup).
            x5-playsinline=""
            webkit-playsinline=""
            disablepictureinpicture="false"
            // NB: no crossOrigin="anonymous" — several archive.org edge
            // nodes omit CORS headers, which turns that attribute into a
            // hard playback death-sentence (ERR_FAILED). Without it the
            // browser does a plain media fetch that plays everywhere.
            // Same-origin sources and CORS-proxied <track> subs are
            // unaffected either way.
            style={{ width: '100%', height: '100%' }}
            onWaiting={() => {
              setBuffering(true);
              if (type !== 'torrent') return;
              // Stall self-heal: nudge the server window to the playhead
              warmAt(videoRef.current?.currentTime || 0);
              // Watchdog: still starved after 15s ⇒ the request silently
              // died (server timeout, reap, proxy). Reattach at the playhead.
              if (stallTimer.current) clearTimeout(stallTimer.current);
              stallTimer.current = setTimeout(() => {
                stallTimer.current = null;
                const vv = videoRef.current;
                if (!vv || vv.paused || vv.readyState >= 3) return;
                if (phaseRef.current === 'play') scheduleReconnect('Playback stalled');
              }, STALL_WATCHDOG_MS);
            }}
            onPlaying={() => {
              setBuffering(false);
              setPlaying(true);
              // Healthy playback ⇒ reset the auto-reconnect bookkeeping
              playedAnyRef.current = true;
              reconnects.current = 0;
              setConnNote(null);
              if (stallTimer.current) { clearTimeout(stallTimer.current); stallTimer.current = null; }
            }}
            onCanPlay={() => {
              setBuffering(false);
              const v = videoRef.current;
              if (v && pendingSeek.current != null && pendingSeek.current > 1) {
                try { v.currentTime = pendingSeek.current; } catch { /* fine */ }
                pendingSeek.current = null;
              }
              if (v && wantPlayRef.current) {
                wantPlayRef.current = false;
                safePlay();
              }
              if (type === 'torrent' && phase === 'ready') {
                setPhase('play');
                applyReady(v, resumeTarget.current);
                resumeTarget.current = 0;
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => { setPlaying(false); pokeUi(); }}
            onEnded={() => { setPlaying(false); setUiVisible(true); persist(); }}
            onLoadedMetadata={() => {
              const d = videoRef.current?.duration || 0;
              if (transcodeRef.current) {
                // fMP4 reports Infinity — rely on the real duration learned
                // from history/metadata for the scrubber math
                setDuration(durRef.current || (isFinite(d) ? d : 0));
              } else {
                setDuration(d);
                if (d > 0) durRef.current = d;
              }
            }}
            onDurationChange={() => {
              const d = videoRef.current?.duration || 0;
              if (transcodeRef.current) {
                setDuration(durRef.current || (isFinite(d) ? d : 0));
              } else {
                setDuration(d);
                if (d > 0) durRef.current = d;
              }
            }}
            onSeeking={() => {
              const vv = videoRef.current;
              if (!isCovered(vv, vv?.currentTime || 0)) setBuffering(true);
            }}
            onError={() => {
              if (type === 'archive') {
                // Direct CDN media can be CORS-blocked by some archive.org
                // edge nodes (the old crossOrigin attr made this fatal).
                // Swap to the server's range-capable proxy, same position.
                if (!archiveProxied.current && archiveProxyUrl.current) {
                  archiveProxied.current = true;
                  const pos = videoRef.current?.currentTime || 0;
                  pendingSeek.current = pos;
                  wantPlayRef.current = true;
                  setInfo((i) => ({ ...i, src: archiveProxyUrl.current }));
                  setSrcKey((k) => k + 1);
                  setBuffering(true);
                }
                return;
              }
              // Torrent stream failed — server setup-timeout (503), swarm
              // starve-out, governor reap, etc. NEVER dead-stop: reconnect
              // in place at the mirrored playhead with backoff. Only a drop
              // during the warmup gate itself goes back through the gate.
              if (phaseRef.current === 'warming') {
                setWarmError('Stream interrupted — re-warming…');
                const gen = generation.current;
                setInfo((i) => ({ ...i, src: null }));
                setTimeout(() => { if (generation.current === gen) retryWarmup(); }, 800);
                return;
              }
              scheduleReconnect('Stream interrupted');
            }}
            onTimeUpdate={() => {
              const v = videoRef.current;
              if (!v) return;
              const now = performance.now();
              if (now - lastTimePush.current > 500 || Math.abs(v.currentTime - curTime) > 1) {
                lastTimePush.current = now;
                setCurTime(v.currentTime);
                curTimeRef.current = v.currentTime;
              }
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
        ) : (
          <div style={{ width: '100%', height: '100%' }} />
        )}

        {/* Center flash icon */}
        {flash && (
          <div className="player-flash" key={flash + Date.now()}>
            {flash === 'play' ? <Play size={44} fill="currentColor" /> : <Pause size={44} fill="currentColor" />}
          </div>
        )}

        {/* Warmup gate overlay — "load the starting 1 minute, then play" */}
        {warming && !loading && (
          <div className="warm-overlay" onClick={(e) => e.stopPropagation()}>
            <div className="warm-card">
              <div className="spinner" />
              <div className="warm-title">{info.title}</div>
              <div className="warm-line">{warmLine || 'Preparing stream…'}</div>
              {connNote && <div className="warm-line conn-note">{connNote}</div>}
              {warm?.containerPlayable === false && !tcAvailRef.current && (
                <div className="warm-warn">
                  ⚠ This file is {warm.fileName?.split('.').pop()?.toUpperCase()} — browsers can't decode it (MKV/HEVC).
                  Install <code>ffmpeg</code> on the server to play it transcoded, or use an MP4/H.264 source.
                </div>
              )}
              <div className="warm-actions">
                {warmError && (
                  <button className="btn btn-primary btn-sm" onClick={retryWarmup}>
                    <RotateCw size={14} /> Retry now
                  </button>
                )}
                {!warmError && warm?.containerPlayable !== false && !warm?.poisoned
                  && (warm?.bufferedFromPos || 0) >= EARLY_PLAY_MIN_BYTES && (
                  <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); playEarly(); }}>
                    <Play size={14} /> Play now · buffered {formatBytes(warm.bufferedFromPos)}
                  </button>
                )}
                <button className="btn btn-dark btn-sm" onClick={goBack}>Back</button>
              </div>
            </div>
          </div>
        )}

        {buffering && !loading && !warming && (
          <div className="buffer-overlay" onClick={(e) => e.stopPropagation()}>
            <div className="spinner" />
            {connNote && (
              <div className="conn-note">
                {connNote}
                <button
                  className="btn btn-dark btn-sm"
                  style={{ marginLeft: 10 }}
                  onClick={(e) => { e.stopPropagation(); retryWarmup(); }}
                >
                  Full re-warm
                </button>
              </div>
            )}
          </div>
        )}

        {resumeNote != null && !warming && (
          <div className="resume-toast" onClick={(e) => e.stopPropagation()}>
            <span>Resumed from {formatTime(resumeNote)}</span>
            <button className="btn btn-dark btn-sm"
              onClick={() => { performSeek(0.01); setResumeNote(null); }}>
              Start over
            </button>
          </div>
        )}

        {/* Autoplay-with-sound was denied after the warmup gate — video is
            playing muted; one tap restores audio. */}
        {soundBlocked && !loading && info.src && (
          <button
            className="sound-hint"
            onClick={(e) => {
              e.stopPropagation();
              const v = videoRef.current;
              if (v) { v.muted = false; setMuted(false); v.play().catch(() => {}); }
              setSoundBlockedBoth(false);
              pokeUi();
            }}
          >
            <VolumeX size={16} /> Tap for sound
          </button>
        )}

        {tcMenu && type === 'torrent' && (
          <div className="sub-menu" onClick={(e) => e.stopPropagation()}>
            <h5>Quality</h5>
            <button className={`sub-item ${qualityPref === 'auto' ? 'active' : ''}`} onClick={() => pickQuality('auto')}>
              ✨ Auto <span className="q-note">source when playable, 720p transcode otherwise</span>
            </button>
            <button className={`sub-item ${qualityPref === 'source' ? 'active' : ''}`} onClick={() => pickQuality('source')}>
              🎞️ Source <span className="q-note">original file, untouched</span>
            </button>
            <div style={{ borderTop: '1px solid #2a3242', margin: '8px 0 4px' }} />
            {(tcStatus?.presets || [{ quality: '1080p' }, { quality: '720p' }, { quality: '480p' }, { quality: '360p' }]).map((p) => (
              <button
                key={p.quality}
                className={`sub-item ${qualityPref === p.quality ? 'active' : ''}`}
                disabled={!tcStatus?.available}
                onClick={() => pickQuality(p.quality)}
              >
                {p.quality}
                {p.note === 'recommended' && <span className="q-note">· recommended</span>}
                {p.note === 'heavy' && <span className="q-note">· CPU heavy on laptops</span>}
              </button>
            ))}
            {!tcStatus?.available && (
              <div className="q-unavail">
                Lower qualities need <strong>ffmpeg</strong> on the server — on Ubuntu: <code>sudo apt install ffmpeg</code>, then restart.
              </div>
            )}
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
        {!loading && !isIos && !warming && info.src && (
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
              {type === 'torrent' && (
                <button
                  className={`icon-btn ctrl ${tcMenu ? 'on' : ''}`}
                  onClick={() => { setTcMenu((s) => !s); setSubMenu(false); pokeUi(); }}
                  title="Quality"
                >
                  <Settings />
                  <span className="q-chip">{transcodeQ || (qualityPref === 'source' ? 'HD' : 'Auto')}</span>
                </button>
              )}
              <button className={`icon-btn ctrl ${subMenu ? 'on' : ''}`} onClick={() => { setSubMenu((s) => !s); setTcMenu(false); pokeUi(); }} title="Captions">
                <MessageSquare />
              </button>
              <button className="icon-btn ctrl" onClick={togglePip} title="Picture in picture">
                <PictureInPicture2 />
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
