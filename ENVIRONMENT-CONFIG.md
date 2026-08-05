# 🌍 ENVIRONMENT CONFIGURATION GUIDE

## 🎯 Overview

The Seedbox Lite application now supports **flexible environment configuration** for easy deployment across multiple machines and environments. No more hardcoded URLs!

## 📁 Environment Files

### Available Configuration Files:
- `.env` - Default development configuration
- `.env.example` - Template with all available options
- `.env.production` - Production deployment settings
- `.env.docker` - Docker container configuration
- `client/.env` - Frontend-specific variables

## 🔧 Configuration Variables

### Backend Server Configuration
```bash
# Server Settings
SERVER_PORT=3000                    # Port the backend runs on
SERVER_HOST=localhost               # Host binding (0.0.0.0 for all interfaces)
SERVER_PROTOCOL=http                # http or https

# CORS & Frontend Integration
FRONTEND_URL=http://localhost:5173  # Frontend URL for CORS
VITE_API_BASE_URL=http://localhost:3000  # API URL for frontend calls

# External Services
OPENSUBTITLES_API_URL=https://rest.opensubtitles.org
SUBTITLE_SEEKER_API_URL=https://api.subtitleseeker.com

# Environment
NODE_ENV=development                # development or production
```

### Frontend Configuration
```bash
# Client Environment (client/.env)
VITE_API_BASE_URL=http://localhost:3000  # Backend API URL
```

## 🚀 Quick Start Examples

### 1. Local Development (Default)
```bash
# Use .env file (already configured)
npm run dev       # Frontend
npm start         # Backend
```

### 2. Different Machine/Network
```bash
# Edit .env file to match your setup:
SERVER_HOST=192.168.1.100
VITE_API_BASE_URL=http://192.168.1.100:3000
FRONTEND_URL=http://192.168.1.200:5173
```

### 3. Production Deployment
```bash
# Copy production config
cp .env.production .env

# Edit with your domain
SERVER_PROTOCOL=https
VITE_API_BASE_URL=https://api.yourdomain.com
FRONTEND_URL=https://yourdomain.com
```

### 4. Docker Setup
```bash
# Use Docker config
cp .env.docker .env

# Bind to all interfaces for container access
SERVER_HOST=0.0.0.0
```

## 🔄 Migration from Hardcoded URLs

### ✅ What's Changed:
- **Frontend**: All `localhost:3000` calls now use `config.api.*`
- **Backend**: Server binding and CORS now configurable
- **Vite**: Proxy configuration reads from environment
- **External APIs**: Subtitle service URLs configurable

### 🎯 Benefits:
- **Multi-machine deployment** - Easy network setup
- **Docker-friendly** - Container-ready configuration
- **Production-ready** - HTTPS and domain support
- **Development-friendly** - Flexible local testing

## 📋 Configuration Reference

### Development Scenarios

#### Scenario 1: Same Machine
```bash
SERVER_PORT=3000
SERVER_HOST=localhost
VITE_API_BASE_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
```

#### Scenario 2: Different Machines
```bash
# Backend machine: 192.168.1.10
SERVER_PORT=3000
SERVER_HOST=0.0.0.0
FRONTEND_URL=http://192.168.1.20:5173

# Frontend machine: 192.168.1.20
VITE_API_BASE_URL=http://192.168.1.10:3000
```

#### Scenario 3: Custom Ports
```bash
SERVER_PORT=8080
VITE_API_BASE_URL=http://localhost:8080
```

#### Scenario 4: HTTPS Production
```bash
SERVER_PROTOCOL=https
SERVER_HOST=0.0.0.0
VITE_API_BASE_URL=https://api.mydomain.com
FRONTEND_URL=https://mydomain.com
```

## 🛠️ Implementation Details

### Frontend API Configuration
The frontend talks to the API through the centralized client in
`client/src/services/api.js`. It uses the same-origin base by default, and
self-heals to the page's own origin when a baked `VITE_API_BASE_URL` is
unreachable:
```javascript
import { apiBase } from './services/api'; // 'https://api.example.com' or '' (same-origin)

// Old way (hardcoded)
fetch('http://localhost:3000/api/torrents')

// New way (configurable + same-origin aware)
fetch(`${apiBase()}/api/torrents`)
```

### Available Frontend Helpers
```javascript
config.apiBaseUrl                           // Base API URL
config.api.torrents                         // /api/torrents endpoint
config.getTorrentUrl(hash, 'files')         // Torrent-specific endpoints  
config.getStreamUrl(hash, fileIndex)       // Streaming URLs
config.getDownloadUrl(hash, fileIndex)     // Download URLs
```

### Backend Configuration Loading
```javascript
// Automatically loads environment variables
const config = {
  server: {
    port: process.env.SERVER_PORT || 3000,
    host: process.env.SERVER_HOST || 'localhost',
    protocol: process.env.SERVER_PROTOCOL || 'http'
  },
  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:5173'
  }
};
```

## 🔍 Troubleshooting

### Common Issues:

1. **CORS Errors**
   - Check `FRONTEND_URL` matches your frontend's actual URL
   - Ensure `SERVER_HOST=0.0.0.0` for network access

2. **API Not Found**
   - Verify `VITE_API_BASE_URL` points to correct backend
   - Check if backend is running on configured port

3. **Network Access Issues**
   - Use `0.0.0.0` for `SERVER_HOST` to allow external connections
   - Check firewall settings for configured ports

### Verification Commands:
```bash
# Check backend configuration
curl http://your-backend-host:3000/api/health

# Check environment loading
echo $VITE_API_BASE_URL
```

## 📝 Migration Checklist

- [x] ✅ Backend: Environment configuration loaded
- [x] ✅ Backend: CORS configured with environment
- [x] ✅ Backend: Server binding configurable  
- [x] ✅ Frontend: API URLs use environment config
- [x] ✅ Frontend: Vite proxy uses environment
- [x] ✅ All components: Updated to use config helper
- [x] ✅ Documentation: Environment examples provided

## 🎉 Ready for Multi-Machine Deployment!

Your Seedbox Lite application is now **completely environment-configurable** and ready for deployment on any machine or network setup.
