    server: {
      // Accept any Host header in dev (tunnels, sandbox previews, LAN IPs).
      allowedHosts: true,
      host: true,
      proxy: {
        "/api": {
          target: apiBaseUrl,