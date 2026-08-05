# Heiken - Docker Deployment Guide

This guide covers deploying Heiken using Docker Compose for different environments.

## 🚀 Quick Start

### Development Environment
```bash
# Clone the repository
git clone <your-repo-url> seedbox-lite
cd seedbox-lite

# Start development environment with hot reload
docker-compose up --build
```

### Production Environment
```bash
# Start production environment with nginx proxy
docker-compose -f docker-compose.yml -f docker-compose.prod.yml --profile production up --build -d
```

## 📁 File Structure

```
seedbox-lite/
├── docker-compose.yml              # Main compose file
├── docker-compose.override.yml     # Development overrides
├── docker-compose.prod.yml         # Production overrides
├── nginx/
│   └── nginx.conf                  # Production nginx config
├── server/
│   ├── Dockerfile                  # Backend production image
│   ├── .dockerignore              # Backend ignore patterns
│   └── .env.docker                # Backend docker env vars
└── client/
    ├── Dockerfile                  # Frontend production image
    ├── Dockerfile.dev             # Frontend development image
    ├── nginx.conf                 # Frontend nginx config
    ├── .dockerignore              # Frontend ignore patterns
    └── .env.production            # Frontend production env vars
```

## 🛠 Configuration

### Environment Variables

#### Backend (.env.docker)
```bash
NODE_ENV=production
SERVER_PORT=3001
SERVER_HOST=0.0.0.0
FRONTEND_URL=https://<domain>
ACCESS_PASSWORD=test123456
```

#### Frontend (.env.production)
```bash
VITE_API_BASE_URL=https://seedbox-api.<domain>
```

### Custom Configuration
1. Update domain names in environment files
2. Modify `ACCESS_PASSWORD` for security
3. Configure SSL certificates for HTTPS (see nginx config)

## 🌐 Deployment Scenarios

### 1. Local Development
```bash
# Start with hot reload and file watching
docker-compose up --build

# Access:
# Frontend: http://localhost:5174
# Backend: http://localhost:3001
```

### 2. Production without Reverse Proxy
```bash
# Start frontend and backend only
docker-compose up --build -d seedbox-frontend seedbox-backend

# Access:
# Frontend: http://localhost:5174
# Backend: http://localhost:3001
```

### 3. Production with Nginx Reverse Proxy
```bash
# Start all services including nginx
docker-compose -f docker-compose.yml -f docker-compose.prod.yml --profile production up --build -d

# Access:
# Application: http://localhost
# All API calls proxied through nginx
```

### 4. Custom Ports
```bash
# Override ports in docker-compose.override.yml or use environment variables
FRONTEND_PORT=8080 BACKEND_PORT=8081 docker-compose up
```

## 🔧 Container Details

### Backend Container (seedbox-backend)
- **Base Image**: node:18-alpine
- **Port**: 3001
- **Volumes**: 
  - `seedbox_data:/app/data` (torrent data)
  - `seedbox_cache:/app/cache` (cache storage)
  - `./server/logs:/app/logs` (application logs)
- **Health Check**: GET /api/health

### Frontend Container (seedbox-frontend)
- **Base Image**: nginx:alpine (production) / node:18-alpine (development)
- **Port**: 80 (production) / 5174 (development)
- **Features**: 
  - Gzip compression
  - Static file caching
  - Security headers
  - React Router support

### Nginx Proxy Container (nginx)
- **Base Image**: nginx:alpine
- **Ports**: 80, 443
- **Features**:
  - Rate limiting
  - SSL termination (when configured)
  - API and frontend routing
  - CORS handling

## 📊 Monitoring & Logs

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f seedbox-backend
docker-compose logs -f seedbox-frontend
```

### Health Checks
```bash
# Check container health
docker-compose ps

# Manual health check
curl http://localhost:3001/api/health  # Backend
curl http://localhost:5174/health      # Frontend
```

### Volume Management
```bash
# List volumes
docker volume ls

# Inspect volume
docker volume inspect seedbox-lite_seedbox_data

# Backup volume
docker run --rm -v seedbox-lite_seedbox_data:/data -v $(pwd):/backup alpine tar czf /backup/seedbox_data_backup.tar.gz -C /data .
```

## 🔒 Security Features

### Container Security
- Non-root user execution
- Minimal base images (Alpine Linux)
- Security headers configured
- Rate limiting enabled

### Network Security
- Isolated Docker network
- CORS properly configured
- SSL support ready (certificates needed)

### Data Security
- Named volumes for persistent data
- Proper file permissions
- Log rotation configured

## 🚨 Troubleshooting

### Common Issues

#### 1. Port Conflicts
```bash
# Check if ports are in use
lsof -i :3001
lsof -i :5174

# Use different ports
FRONTEND_PORT=8080 BACKEND_PORT=8081 docker-compose up
```

#### 2. Permission Issues
```bash
# Fix volume permissions
docker-compose exec seedbox-backend chown -R nodejs:nodejs /app/data /app/cache
```

#### 3. Build Failures
```bash
# Clean rebuild
docker-compose down --volumes
docker system prune -f
docker-compose build --no-cache
```

#### 4. Network Issues
```bash
# Recreate network
docker-compose down
docker network prune
docker-compose up
```

### Debug Mode
```bash
# Run with debug output
DEBUG=* docker-compose up

# Shell into container
docker-compose exec seedbox-backend sh
docker-compose exec seedbox-frontend sh
```

## 🔄 Updates & Maintenance

### Update Application
```bash
# Pull latest code
git pull

# Rebuild and restart
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Cleanup
```bash
# Remove stopped containers
docker-compose down --remove-orphans

# Clean unused images
docker image prune -f

# Full cleanup (caution: removes volumes)
docker-compose down --volumes
docker system prune -a -f
```

## 📝 Production Checklist

- [ ] Update domain names in environment files
- [ ] Change default passwords
- [ ] Configure SSL certificates
- [ ] Set up log rotation
- [ ] Configure monitoring
- [ ] Test backup and restore procedures
- [ ] Configure firewall rules
- [ ] Set up automated updates

## 🌍 Scaling & Performance

### Horizontal Scaling
```bash
# Scale backend instances
docker-compose up --scale seedbox-backend=3

# Use nginx load balancing (update nginx.conf)
upstream backend {
    server seedbox-backend_1:3001;
    server seedbox-backend_2:3001;
    server seedbox-backend_3:3001;
}
```

### Resource Limits
Add to docker-compose.yml:
```yaml
services:
  seedbox-backend:
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M
```

## 🤝 Support

For issues and questions:
1. Check the troubleshooting section
2. Review container logs
3. Ensure all environment variables are set correctly
4. Verify network connectivity between containers
