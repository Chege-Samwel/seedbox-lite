// Universal Torrent Resolution System - ZERO "Not Found" Errors
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const WebTorrent = require('webtorrent');
const multer = require('multer');
const { RollingDiskChunkStore, stats: storeStats } = require('./lib/rollingStore');

// Environment Configuration with production optimizations
const config = {
  server: {
    port: process.env.SERVER_PORT || 3000,
    host: process.env.SERVER_HOST || 'localhost',
    protocol: process.env.SERVER_PROTOCOL || 'http'
  },
  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:5173'
  },
  omdb: {
    apiKey: process.env.OMDB_API_KEY || '8265bd1c' // Free API key for development
  },
  isDevelopment: process.env.NODE_ENV !== 'production',
  
  // Production-specific configuration
  production: {
    // Streaming settings
    streaming: {
      // Maximum time in ms for any streaming request to stay open
      maxConnectionTime: 300000, // 5 minutes
      // Default chunk size for video streaming
      defaultChunkSize: 4 * 1024 * 1024, // 4MB
      // Upload rate during streaming to ensure good peer reciprocity
      streamingUploadRate: 10000, // 10KB/s
      // Enable optimization for remote deployments like DigitalOcean
      optimizeForRemote: true
    },
    
    // Cache settings
    cache: {
      // Time in ms to cache torrent listings
      torrentListTTL: 5000, // 5 seconds
      // Time in ms to cache torrent details
      torrentDetailsTTL: 8000, // 8 seconds
      // Time in ms to cache IMDB data
      imdbDataTTL: 3600000, // 1 hour
      // Memory threshold in MB to trigger cache purge
      memoryCachePurgeThreshold: 800 // 800MB
    },
    
    // System settings
    system: {
      // Maximum memory usage before taking action (MB)
      maxMemory: 1024, // 1GB
      // Enable system health monitoring
      monitoring: true,
      // Log level (0=errors only, 1=important, 2=verbose)
      logLevel: parseInt(process.env.LOG_LEVEL || '1', 10)
    },
    
    // Network settings
    network: {
      // Maximum number of connections per torrent
      maxConns: 100,
      // Default upload limit in bytes/sec
      defaultUploadLimit: 5000, // 5KB/s
      // Timeout for API requests
      apiTimeout: 15000 // 15 seconds
    }
  }
};

const app = express();

// CORS Configuration - Allow all origins (move after app initialization)
console.log('🌐 CORS: Allowing ALL origins (permissive mode)');

// Simple CORS configuration allowing all origins
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'ngrok-skip-browser-warning'
  ],
  optionsSuccessStatus: 200
}));

// Additional permissive CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With,Accept,Origin,ngrok-skip-browser-warning');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

// Add performance monitoring middleware for API endpoints
app.use((req, res, next) => {
  // Skip for non-API routes
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  // Store start time
  const startTime = Date.now();
  
  // Track if the response has been sent
  let responseSent = false;
  
  // Create a function to log response time
  const logResponseTime = () => {
    if (responseSent) return;
    responseSent = true;
    
    const duration = Date.now() - startTime;
    
    // Only log slow requests or in debug mode
    const isSlowRequest = duration > 1000;
    const debugLevel = process.env.DEBUG === 'true';
    
    if (isSlowRequest || debugLevel) {
      const routeName = req.path;
      console.log(
        `⏱️ ${isSlowRequest ? '⚠️ SLOW API' : 'API'} ${req.method} ${routeName}: ${duration}ms` +
        (isSlowRequest ? ' - Consider optimization!' : '')
      );
    }
  };
  
  // Log when response is finished
  res.on('finish', logResponseTime);
  res.on('close', logResponseTime);
  
  // Set a global timeout for all API requests (30s: metadata/catalog lookups
  // may take a while when providers are slow or unreachable).
  // EXEMPT video streams/downloads: a fresh seek into an unbuffered region
  // legitimately takes longer on a slow swarm, and the stream handler has
  // its own 60s timeout.
  const isStreamRoute = /\/api\/torrents\/[^/]+\/files\/[^/]+\/(stream|download|transcode)/.test(req.path)
    || req.path === '/api/browse/stream'; // archive.org media proxy — long-lived by nature
  if (isStreamRoute) return next();

  res.setTimeout(30000, () => {
    console.log(`⏱️ ⚠️ Global timeout reached for ${req.path}`);
    if (!res.headersSent) {
      res.status(503).send({ 
        error: 'Request timeout', 
        message: 'Server is busy, please try again later' 
      });
    }
  });
  
  next();
});

// OPTIMIZED WebTorrent configuration for production and cloud environments
const isProduction = process.env.NODE_ENV === 'production';
const isCloud = process.env.CLOUD_DEPLOYMENT === 'true' || 
                process.env.DIGITAL_OCEAN === 'true' ||
                process.env.HOSTING === 'cloud';

console.log(`🌐 Running in ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);
if (isCloud) console.log(`☁️ Cloud/DigitalOcean deployment detected`);

// Central resource budget (LITE_MODE presets + explicit env overrides).
const tuning = require('./lib/tuning');
if (tuning.lite) {
  console.log('🍃 LITE MODE active — reduced memory/CPU budget for small hosts');
  console.log(`🍃 Budget: ${tuning.describe()}`);
}

// Apply production optimization
const client = new WebTorrent({
  uploadLimit: isProduction ? config.production.network.defaultUploadLimit : 10000,
  downloadLimit: -1, // No download limit
  maxConns: tuning.lite ? tuning.maxConns : (isProduction ? config.production.network.maxConns : tuning.maxConns),
  webSeeds: true,    // Enable web seeds
  tracker: true,     // Enable trackers
  pex: true,         // Enable peer exchange
  dht: true,         // Enable DHT

  // Constrain long-lived web connections when the budget says so
  ...(tuning.lite && { maxWebConns: tuning.maxWebConns }),

  // Additional network optimizations for cloud environments
  ...(isCloud && {
    // More conservative connection handling for cloud environments
    maxConns: tuning.lite ? tuning.maxConns : 80, // Reduced connections to prevent overwhelming the server
    maxWebConns: tuning.maxWebConns, // Lower web connections limit
    
    // Apply more aggressive timeouts for DHT and tracker communication
    dhtTimeout: 10000,       // 10 seconds DHT timeout
    trackerTimeout: 15000,   // 15 seconds tracker timeout
    
    // Avoid going offline by keeping connections alive
    keepSeeding: true,
    
    // Throttle UDP traffic to avoid triggering anti-DoS mechanisms
    utp: true                // Use uTP protocol which is more network-friendly
  })
});

// UNIVERSAL STORAGE SYSTEM - Multiple ways to find torrents
const torrents = {};           // Active torrent objects by infoHash
const torrentIds = {};         // Original torrent IDs by infoHash
const torrentNames = {};       // Torrent names by infoHash
const hashToName = {};         // Quick hash-to-name lookup
const nameToHash = {};         // Quick name-to-hash lookup

// ════════════════════════════════════════════════════════════════[...]
// MEMORY GOVERNOR — sliding time-window buffer policy so the swarm can
// never pull a whole multi-GB file into RAM (this caused OOM kills).
// ════════════════════════════════════════════════════════════════[...]
const windowGovernor = require('./lib/windowGovernor');

function destroyTorrentEverywhere(infoHash) {
  try {
    const torrent = client.torrents.find((t) => t.infoHash === infoHash);
    const name = torrentNames[infoHash];
    delete torrents[infoHash];
    delete torrentIds[infoHash];
    delete torrentNames[infoHash];
    delete hashToName[infoHash];
    if (name) delete nameToHash[name];
    if (torrent) client.remove(torrent);
  } catch (err) {
    console.warn(`⚠️ Governor destroy failed for ${infoHash}: ${err.message}`);
  }
}

const governor = windowGovernor.create(client, destroyTorrentEverywhere);
app.locals.governor = governor;

// SWARM GUARD — a poisoned/fake swarm (garbage pieces at speed) otherwise
// pegs the event loop on hash-verify-discard churn until NOTHING loads:
// health checks, login, history — the field "the stall crashed the server".
const swarmGuard = require('./lib/swarmGuard').start({ client });
app.locals.swarmGuard = swarmGuard;

// STREAM SHED — bound concurrent live stream responses. On a starved swarm,
// browser retries + the player's auto-reconnect can stack hundreds of
// long-lived range responses that each pull trickles; past this cap we
// answer a cheap fast-503 (the player auto-retries) instead of piling up.
let activeStreamResponses = 0;
const MAX_STREAM_RESPONSES = parseInt(process.env.MAX_STREAM_RESPONSES || (tuning.lite ? '12' : '24'), 10);

// Deduplicate concurrent loads: user habits (double-click, exit & re-enter,
// home re-render + player open) otherwise spawn parallel client.add() calls
// for the same hash — three 60s timeouts, duplicate warmups, and a whole-file
// file.select() from the timeout fallback (this was the field OOM path).
const loadingPromises = new Map(); // infoHash → Promise<torrent>
const isLoadingHash = (hash) => hash && loadingPromises.has(String(hash).toLowerCase());

function hashFromId(torrentId) {
  if (!torrentId) return null;
  const m = String(torrentId).match(/xt=urn:btih:([a-zA-Z0-9]{32,40})/i);
  if (m) return m[1].toLowerCase();
  if (/^[a-fA-F0-9]{40}$/.test(torrentId)) return torrentId.toLowerCase();
  return null;
}

// Warmup orchestrator: "1 minute ready" buffering, started on Play click and
// re-centered on seek — never on add (adding several magnets stays cheap).
const warmupOrchestrator = require('./lib/warmup').create({
  client,
  governor,
  isLoading: isLoadingHash,
});
app.locals.warmup = warmupOrchestrator;

// IMDB Integration
const imdbCache = new Map();

  // Enhanced title cleaning for better API results
  function cleanTorrentName(torrentName) { const debugLevel = process.env.DEBUG === 'true';
    if (debugLevel) console.log(`🔍 Cleaning torrent name: "${torrentName}"`);
    
    // Extract year first before cleaning
    const yearMatch = torrentName.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[0] : null;
    
    // Enhanced series detection - more comprehensive patterns
    const isLikelySeries = /\b(S\d+|Season|SEASON|series|Series|SERIES|E\d+|Episode|EPISODE|COMPLETE|Complete|complete)\b/i.test(torrentName);
    if (debugLevel) console.log(`📺 Series detection: ${isLikelySeries ? 'YES' : 'NO'}`);
    
    // First pass: Remove common torrent artifacts
    let cleaned = torrentName
      .replace(/\[(.*?)\]/g, '') // Remove [groups] like [YTS.MX], [OxTorrent.com]
      .replace(/\((.*?)\)/g, '') // Remove (year) and other parentheses content initially
      .replace(/\.(720p|1080p|480p|2160p|4K)/gi, '') // Remove quality indicators
      .replace(/\.(BluRay|WEBRip|WEB-DL|DVDRip|CAMRip|TS|TC|WEB)/gi, '') // Remove source indicators
      .replace(/\.(x264|x265|H264|H265|HEVC|AVC)/gi, '') // Remove codec info
      .replace(/\.(AAC|MP3|AC3|DTS|FLAC)/gi, '') // Remove audio codec
      .replace(/\.(mkv|mp4|avi|mov|flv)/gi, '') // Remove file extensions
      .replace(/\b(REPACK|PROPER|EXTENDED|UNRATED|DIRECTORS|CUT)\b/gi, '') // Remove edition info
      .replace(/\b\d+CH\b/gi, '') // Remove channel info like 2CH, 5.1CH
      .replace(/\b(PSA|YTS|YIFY|RARBG|EZTV|TGx)\b/gi, '') // Remove release groups
      .replace(/\./g, ' ') // Replace dots with spaces
      .replace(/[-_]/g, ' ') // Replace hyphens and underscores with spaces
      .replace(/\s+/g, ' ') // Normalize multiple spaces
      .trim();
    
    if (debugLevel) console.log(`🧹 After basic cleaning: "${cleaned}"`);
    
    if (isLikelySeries) {
      if (debugLevel) console.log(`📺 Applying series-specific cleaning`);
      
      // For series, aggressively remove season/episode specific info
      cleaned = cleaned
        .replace(/\b(S\d+.*)/gi, '') // Remove S01 and everything after
        .replace(/\b(Season\s*\d+.*)/gi, '') // Remove Season 1 and everything after
        .replace(/\b(SEASON\s*\d+.*)/gi, '') // Remove SEASON 1 and everything after
        .replace(/\b(E\d+.*)/gi, '') // Remove E01 and everything after
        .replace(/\b(Episode\s*\d+.*)/gi, '') // Remove Episode 1 and everything after
        .replace(/\b(EPISODE\s*\d+.*)/gi, '') // Remove EPISODE 1 and everything after
        .replace(/\b(COMPLETE.*)/gi, '') // Remove COMPLETE and everything after
        .replace(/\b(Complete.*)/gi, '') // Remove Complete and everything after
        .replace(/\b(complete.*)/gi, '') // Remove complete and everything after
        .replace(/\bSERIES\b/gi, '') // Remove standalone SERIES word
        .replace(/\bSeries\b/gi, '') // Remove standalone Series word
        .replace(/\bseries\b/gi, '') // Remove standalone series word
        .replace(/\bWEB\b/gi, '') // Remove WEB
        .replace(/\b\d+CH\b/gi, '') // Remove channel info again
        .replace(/\b(PSA|YTS|YIFY|RARBG|EZTV|TGx)\b/gi, '') // Remove release groups again
        .trim();
    }
    
    // Final cleanup
    cleaned = cleaned
      .replace(/\s+/g, ' ')
      .trim();
    
    if (debugLevel) console.log(`✨ Final cleaned result: title="${cleaned}", year=${year}`);
    return { title: cleaned, year };
  }

// ... rest of the file remains the same (omitted for brevity) - unchanged from main branch
