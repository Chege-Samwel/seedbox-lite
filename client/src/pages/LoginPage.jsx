      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(`${base}/api/health?ngrok-skip-browser-warning=1`, {
          signal: ctrl.signal,
          headers: { 'ngrok-skip-browser-warning': 'true' },
        });
        clearTimeout(t);
        const data = await r.json().catch(() => null);
        if (!stop) setProbe({ host: base, ok: r.ok && data?.status === 'ok' });
      } catch {
        if (!stop) setProbe({ host: base, ok: false });
      }

  const applyServerAddr = () => {
    setApiBaseOverride(serverAddr);
    const applied = apiBase();
    setServerAddr(applied);
    setSavedAddr(applied);
    setProbe(null); // the sb_api_base_changed listener re-probes immediately
  };