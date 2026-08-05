import React, { useEffect, useState } from 'react';
import { Download, X, MonitorSmartphone } from 'lucide-react';

/**
 * Install-app hint for phones & Android TV.
 *
 * Heiken is a PWA: on Android phones (Chrome) and Android TV (TV Bro /
 * Chromium TV browsers) the user can add it to the home screen like a
 * native app — fullscreen, standalone, own icon. This hint nudges them the
 * first few visits. It listens for the browser's install prompt
 * (beforeinstallprompt) and falls back to a "how to install" note on
 * devices where Chrome doesn't fire it automatically (e.g. some TV
 * browsers).
 */
export default function InstallHint() {
  const [show, setShow] = useState(false);
  const [deferred, setDeferred] = useState(null);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('heiken_install_dismissed')) return;

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (isStandalone) return;

    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
      setShow(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);

    // No install prompt fired within 3s → still offer the manual "how to".
    const t = setTimeout(() => {
      if (!deferred) {
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const isTv = /TV|BRAVIA|Viera|Web0S|Tizen/i.test(navigator.userAgent) || window.innerWidth > 1280;
        if (isMobile || isTv) { setShow(true); setIosHint(true); }
      }
    }, 3000);

    return () => { clearTimeout(t); window.removeEventListener('beforeinstallprompt', onPrompt); };
  }, [deferred]);

  const dismiss = () => {
    localStorage.setItem('heiken_install_dismissed', '1');
    setShow(false);
  };

  if (!show) return null;

  const doInstall = async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
      if (outcome === 'accepted') setShow(false);
      setDeferred(null);
    } else {
      // No browser install prompt — explain the manual path.
      setIosHint(true);
    }
  };

  return (
    <div className="install-hint" role="dialog" aria-label="Install Heiken">
      <MonitorSmartphone size={16} />
      <span className="install-hint-text">
        {iosHint
          ? 'Install Heiken like an app: browser menu → “Add to Home screen” (or “Install app” on TV Bro).'
          : 'Install Heiken on your Home screen for fullscreen app-like playback.'}
      </span>
      {!iosHint && (
        <button className="btn btn-primary btn-sm" onClick={doInstall}>
          <Download size={13} /> Install
        </button>
      )}
      <button className="icon-btn install-hint-close" onClick={dismiss} title="Dismiss" aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
