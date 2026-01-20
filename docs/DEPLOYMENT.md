# OpenDexViewer Deployment Guide

This guide covers deploying OpenDexViewer to Render.com using the included `render.yaml` blueprint.

## Prerequisites

1. A [Render.com](https://render.com) account
2. A [Helius](https://helius.xyz) API key (free tier available)
3. A [Birdeye](https://birdeye.so) API key (free tier available)
4. Git repository with your code

## Quick Deploy (Blueprint)

The easiest way to deploy is using Render's Blueprint feature:

1. Push your code to a GitHub or GitLab repository
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click **New** > **Blueprint**
4. Connect your repository
5. Render will detect the `render.yaml` and create all services

This will automatically create:
- **opendex-api**: Node.js backend service
- **opendex-frontend**: Static site for the frontend
- **opendex-db**: PostgreSQL database

## Manual Setup

If you prefer to set up services manually:

### 1. Create PostgreSQL Database

1. Go to Render Dashboard > **New** > **PostgreSQL**
2. Name: `opendex-db`
3. Region: Oregon (or your preferred region)
4. Plan: Free
5. PostgreSQL Version: 15
6. Click **Create Database**
7. Copy the **Internal Connection String** for later

### 2. Deploy Backend API

1. Go to Render Dashboard > **New** > **Web Service**
2. Connect your GitHub/GitLab repository
3. Configure:
   - **Name**: `opendex-api`
   - **Region**: Same as database
   - **Branch**: `main`
   - **Root Directory**: `backend`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Add Environment Variables (see below)
5. Click **Create Web Service**

### 3. Deploy Frontend

1. Go to Render Dashboard > **New** > **Static Site**
2. Connect your repository
3. Configure:
   - **Name**: `opendex-frontend`
   - **Branch**: `main`
   - **Root Directory**: `frontend`
   - **Build Command**: `echo "No build needed"`
   - **Publish Directory**: `.`
4. Click **Create Static Site**

## Environment Variables

### Required Variables

Set these in your backend service's Environment settings:

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Auto-set if using blueprint |
| `HELIUS_API_KEY` | Your Helius API key | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `BIRDEYE_API_KEY` | Your Birdeye API key | `xxxxxxxxxxxxxxxxxxxxxxxxx` |
| `CORS_ORIGIN` | Frontend URL | `https://opendex-frontend.onrender.com` |
| `NODE_ENV` | Environment | `production` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `10000` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | `60000` |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `100` |
| `RATE_LIMIT_STRICT_MAX` | Strict limit (votes, submissions) | `20` |
| `AUTO_APPROVE_THRESHOLD` | Vote score for auto-approve | `5` |
| `AUTO_REJECT_THRESHOLD` | Vote score for auto-reject | `-5` |
| `CACHE_TOKEN_TTL` | Token cache TTL (seconds) | `300` |
| `CACHE_PRICE_TTL` | Price cache TTL (seconds) | `60` |

## Database Initialization

The database schema is automatically created when the backend starts. If you need to manually run migrations:

```bash
# SSH into your Render service shell, or run locally:
npm run db:migrate

# With seed data:
npm run db:migrate:seed

# Check connection status:
npm run db:status
```

## Post-Deployment Checklist

After deploying, verify these steps:

### 1. Check Health Endpoints

```bash
# Basic health check
curl https://opendex-api.onrender.com/health

# Detailed health (database, cache status)
curl https://opendex-api.onrender.com/health/detailed
```

Expected response:
```json
{
  "status": "healthy",
  "timestamp": "2026-01-19T12:00:00.000Z",
  "database": { "healthy": true },
  "cache": { "healthy": true }
}
```

### 2. Test API Endpoints

```bash
# Get trending tokens
curl https://opendex-api.onrender.com/api/tokens

# Search for a token
curl https://opendex-api.onrender.com/api/tokens/search?q=SOL

# Get token details
curl https://opendex-api.onrender.com/api/tokens/So11111111111111111111111111111111111111112
```

### 3. Verify Frontend

1. Visit your frontend URL
2. Check that tokens load
3. Try searching for a token
4. Click on a token to view details
5. Connect a wallet (if you have Phantom/Solflare)

## Updating the Frontend API URL

If your API URL is different from `opendex-api.onrender.com`, update:

**Option 1**: Edit `frontend/js/api.js`:
```javascript
const API_BASE_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : 'https://YOUR-API-URL.onrender.com';
```

**Option 2**: Edit `frontend/js/config.js`:
```javascript
api: {
  baseUrl: 'https://YOUR-API-URL.onrender.com',
  // ...
}
```

## Custom Domain Setup

### For Frontend (Static Site)

1. Go to your static site settings in Render
2. Click **Custom Domains**
3. Add your domain (e.g., `opendex.yoursite.com`)
4. Add the DNS records shown by Render

### For Backend (API)

1. Go to your web service settings in Render
2. Click **Custom Domains**
3. Add your API domain (e.g., `api.opendex.yoursite.com`)
4. Update `CORS_ORIGIN` to include your frontend domain

## Troubleshooting

### Backend won't start

1. Check the logs in Render Dashboard
2. Verify all environment variables are set
3. Ensure `DATABASE_URL` is correctly formatted
4. Check that the database is running

### Database connection errors

1. Verify the database is in the same region as the API
2. Check that the connection string is using the Internal URL
3. For external connections, ensure IP allowlist is configured

### CORS errors in browser

1. Verify `CORS_ORIGIN` matches your frontend URL exactly
2. Include the protocol (`https://`)
3. Don't include trailing slashes

### Slow cold starts (Free tier)

Render's free tier spins down after 15 minutes of inactivity. The first request after spin-down takes 30-60 seconds. Solutions:
- Upgrade to a paid plan
- Use an external uptime monitor to ping the service
- Accept the occasional slow start

### Rate limiting errors

If you see "Too many requests" errors:
1. Increase `RATE_LIMIT_MAX_REQUESTS`
2. Or increase `RATE_LIMIT_WINDOW_MS`
3. Consider implementing client-side request queuing

## Monitoring

### Render Dashboard

- View real-time logs
- Monitor memory/CPU usage
- Check deploy history

### Custom Logging

The API logs important events. View them in Render's Logs tab:
```
[2026-01-19 12:00:00] Server running on port 10000
[2026-01-19 12:00:01] Database initialized successfully
[2026-01-19 12:00:02] Cache initialized
```

## Scaling (Paid Plans)

For higher traffic, consider:

1. **Upgrade API service**: More instances, more memory
2. **Upgrade database**: More connections, better performance
3. **Add Redis cache**: For distributed caching
4. **Use CDN**: CloudFlare in front of static site

## Security Considerations

1. Never commit API keys to git
2. Use Render's environment variables for secrets
3. Keep `CORS_ORIGIN` restricted to your frontend domain
4. Monitor rate limiting logs for abuse

---

## Getting API Keys

### Helius (Solana RPC)

1. Go to [https://helius.xyz](https://helius.xyz)
2. Create a free account
3. Create a new project
4. Copy your API key

### Birdeye (Token Data)

1. Go to [https://birdeye.so](https://birdeye.so)
2. Sign up for API access
3. Get your API key from the dashboard

---

For more help, check:
- [Render Documentation](https://render.com/docs)
- [Project GitHub Issues](https://github.com/SolPenguin/opendexviewer/issues)
