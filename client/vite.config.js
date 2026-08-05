import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  // Load environment variables
  const env = loadEnv(mode, '.', '');
  const apiBaseUrl = env.VITE_API_BASE_URL || 'http://localhost:3000';
  // Guard the classic footgun: a template value baked into the bundle
  // silently breaks every API call in production.
  if (mode === 'production' && env.VITE_API_BASE_URL && /[<>]/.test(env.VITE_API_BASE_URL)) {
    console.warn(`\n⚠️  VITE_API_BASE_URL ("${env.VITE_API_BASE_URL}") still looks like an unfilled template —\n    leave it EMPTY for same-origin serving, or set a real public https URL for split hosting.\n    (The app will still self-heal at runtime by falling back to same-origin.)\n`);
  }
  
  return {
    plugins: [react()],
    server: {
      // Accept any Host header in dev (tunnels, sandbox previews, LAN IPs).
      allowedHosts: true,
      proxy: {
        "/api": {
          target: apiBaseUrl,
          changeOrigin: true,
          secure: false
        }
      }
    },
    // Expose environment variables to the client
    define: {
      __DEV__: JSON.stringify(mode === 'development'),
      __API_BASE_URL__: JSON.stringify(apiBaseUrl)
    }
  }
})
