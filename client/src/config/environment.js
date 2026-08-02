/**
 * Environment Configuration
 * Provides centralized access to environment variables
 */

// Single source of truth for the API base: services/api (same-origin by
// default, self-heals when a baked URL is wrong). The old module defaulted
// to http://localhost:3000 — poison for any page not literally opened on
// the server machine itself.
import { apiBase } from '../services/api';

// Get API base URL (dynamic: honors the learned same-origin override)
const API_BASE_URL = apiBase();

// Remove trailing slash if present
const normalizeUrl = (url) => url.endsWith('/') ? url.slice(0, -1) : url;

export const config = {
  // API Configuration
  apiBaseUrl: normalizeUrl(API_BASE_URL),
  
  // API Endpoints
  api: {
    torrents: `${normalizeUrl(API_BASE_URL)}/api/torrents`,
    cache: `${normalizeUrl(API_BASE_URL)}/api/cache`,
    system: `${normalizeUrl(API_BASE_URL)}/api/system`,
  },
  
  // Development helpers
  isDevelopment: import.meta.env.DEV,
  isProduction: import.meta.env.PROD,
  
  // Helper functions
  getApiUrl: (endpoint) => `${normalizeUrl(API_BASE_URL)}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`,
  
  // Torrent API helpers
  getTorrentUrl: (infoHash, endpoint = '') => 
    `${normalizeUrl(API_BASE_URL)}/api/torrents/${infoHash}${endpoint ? `/${endpoint}` : ''}`,
    
  getStreamUrl: (infoHash, fileIndex) => 
    `${normalizeUrl(API_BASE_URL)}/api/torrents/${infoHash}/files/${fileIndex}/stream`,
    
  getDownloadUrl: (infoHash, fileIndex) => 
    `${normalizeUrl(API_BASE_URL)}/api/torrents/${infoHash}/files/${fileIndex}/download`,
};

// Log configuration in development
if (config.isDevelopment) {
  console.log('🔧 Environment Configuration:', {
    apiBaseUrl: config.apiBaseUrl,
    environment: config.isDevelopment ? 'development' : 'production'
  });
}
