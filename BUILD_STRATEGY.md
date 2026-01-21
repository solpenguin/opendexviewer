# OpenDexViewer Build Strategy

## Project Overview

**OpenDexViewer** is an open-source, open-access alternative to DexScreener for viewing Solana tokens. The platform allows token leaders to submit banners and social links for free, with community sentiment voting to curate content.

### Core Principles
- **100% Free**: No paid features for banner/social link submissions
- **Community-Driven**: Voting system determines displayed content
- **Open Source**: Fully transparent codebase
- **Independent**: No reliance on DexScreener's API

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Static HTML)                   │
│                    Hosted on Render Static Site                 │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Token List  │  │Token Detail │  │ Submit/Vote Interface   │ │
│  │    Page     │  │    Page     │  │                         │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     BACKEND API (Render Web Service)            │
│                         Node.js + Express                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Token Data   │  │ Submissions  │  │   Voting System      │  │
│  │   Endpoints  │  │   Endpoints  │  │     Endpoints        │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
┌───────────────────┐ ┌─────────────┐ ┌─────────────────────────┐
│  PostgreSQL DB    │ │ Solana RPC  │ │  Jupiter/Raydium APIs   │
│  (Render)         │ │  (Helius/   │ │  (Price & Pool Data)    │
│                   │ │  QuickNode) │ │                         │
└───────────────────┘ └─────────────┘ └─────────────────────────┘
```

---

## Data Sources (DexScreener-Free)

Since we cannot use DexScreener's API, we will use these alternative data sources:

### 1. Solana RPC Providers
- **Helius** (Recommended) - Free tier available, excellent Solana support
- **QuickNode** - Reliable alternative
- **Alchemy** - Good free tier

### 2. DEX Data APIs
- **Jupiter Aggregator API** - Price data, token metadata
- **Raydium API** - Pool data, liquidity info
- **Orca API** - Additional pool data
- **Birdeye API** - Token analytics (has free tier)

### 3. Token Metadata
- **Solana Token List** (via Jupiter)
- **Metaplex Metadata** - On-chain token metadata
- **Solana FM API** - Token information

---

## Phase 1: Project Foundation

### 1.1 Repository Setup
- [ ] Create proper `.gitignore`
- [ ] Set up project folder structure
- [ ] Initialize package.json for backend
- [ ] Create environment variable templates

### 1.2 Folder Structure
```
opendexviewer/
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── tokens.js       # Token data endpoints
│   │   │   ├── submissions.js  # Banner/social submissions
│   │   │   └── votes.js        # Voting endpoints
│   │   ├── services/
│   │   │   ├── solana.js       # Solana RPC interactions
│   │   │   ├── jupiter.js      # Jupiter API integration
│   │   │   └── cache.js        # Data caching layer
│   │   ├── models/
│   │   │   ├── Token.js
│   │   │   ├── Submission.js
│   │   │   └── Vote.js
│   │   ├── middleware/
│   │   │   ├── rateLimit.js
│   │   │   └── validation.js
│   │   └── app.js              # Express app setup
│   ├── package.json
│   └── render.yaml             # Render deployment config
├── frontend/
│   ├── index.html              # Homepage / Token list
│   ├── token.html              # Token detail page
│   ├── submit.html             # Submission page
│   ├── css/
│   │   └── styles.css
│   ├── js/
│   │   ├── api.js              # API client
│   │   ├── tokens.js           # Token list logic
│   │   ├── tokenDetail.js      # Token detail logic
│   │   └── voting.js           # Voting logic
│   └── assets/
│       └── images/
├── docs/
│   └── API.md                  # API documentation
├── BUILD_STRATEGY.md
├── LICENSE
└── README.md
```

---

## Phase 2: Backend Development

### 2.1 Core API Setup
- [ ] Initialize Express.js application
- [ ] Set up CORS for frontend access
- [ ] Configure environment variables
- [ ] Set up error handling middleware
- [ ] Implement rate limiting

### 2.2 Database Schema (PostgreSQL)
```sql
-- Tokens (cached from chain)
CREATE TABLE tokens (
    id SERIAL PRIMARY KEY,
    mint_address VARCHAR(44) UNIQUE NOT NULL,
    name VARCHAR(255),
    symbol VARCHAR(50),
    decimals INTEGER,
    logo_uri TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Submissions (banners, social links)
CREATE TABLE submissions (
    id SERIAL PRIMARY KEY,
    token_mint VARCHAR(44) NOT NULL,
    submission_type VARCHAR(20) NOT NULL, -- 'banner', 'twitter', 'telegram', 'discord', 'website'
    content_url TEXT NOT NULL,
    submitter_wallet VARCHAR(44),
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (token_mint) REFERENCES tokens(mint_address)
);

-- Votes
CREATE TABLE votes (
    id SERIAL PRIMARY KEY,
    submission_id INTEGER NOT NULL,
    voter_wallet VARCHAR(44) NOT NULL,
    vote_type VARCHAR(10) NOT NULL, -- 'up', 'down'
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (submission_id) REFERENCES submissions(id),
    UNIQUE(submission_id, voter_wallet)
);

-- Vote tallies (materialized for performance)
CREATE TABLE vote_tallies (
    submission_id INTEGER PRIMARY KEY,
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (submission_id) REFERENCES submissions(id)
);
```

### 2.3 Solana Data Integration
- [ ] Set up Helius/QuickNode RPC connection
- [ ] Implement token metadata fetching
- [ ] Create Jupiter API integration for prices
- [ ] Implement Raydium pool data fetching
- [ ] Build caching layer (reduce API calls)

### 2.4 API Endpoints

#### Token Endpoints
```
GET  /api/tokens                    # List trending/new tokens
GET  /api/tokens/:mint              # Get single token details
GET  /api/tokens/:mint/price        # Get price data
GET  /api/tokens/:mint/chart        # Get price history
GET  /api/tokens/search?q=          # Search tokens
```

#### Submission Endpoints
```
GET  /api/tokens/:mint/submissions  # Get submissions for token
POST /api/submissions               # Create new submission
GET  /api/submissions/:id           # Get submission details
```

#### Voting Endpoints
```
POST /api/submissions/:id/vote      # Cast vote (wallet signature required)
GET  /api/submissions/:id/votes     # Get vote counts
```

---

## Phase 3: Frontend Development

### 3.1 Homepage (Token List)
- [ ] Token list table/grid
- [ ] Search functionality
- [ ] Sorting (volume, price change, market cap)
- [ ] Filtering (new, trending, gainers, losers)
- [ ] Pagination
- [ ] Responsive design

### 3.2 Token Detail Page
- [ ] Token header (name, symbol, logo)
- [ ] Price chart (using lightweight-charts or Chart.js)
- [ ] Key metrics (price, volume, liquidity, market cap)
- [ ] Community-submitted banner display
- [ ] Social links section
- [ ] Trade links (Jupiter, Raydium)

### 3.3 Submission System
- [ ] Wallet connection (Phantom, Solflare support)
- [ ] Banner upload/URL submission form
- [ ] Social link submission form
- [ ] Submission status tracking

### 3.4 Voting Interface
- [ ] Upvote/downvote buttons
- [ ] Vote count display
- [ ] Wallet signature for voting
- [ ] Visual feedback for user's votes

---

## Phase 4: Deployment on Render

### 4.1 Backend Deployment
```yaml
# render.yaml
services:
  - type: web
    name: opendex-api
    env: node
    buildCommand: cd backend && npm install
    startCommand: cd backend && npm start
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: opendex-db
          property: connectionString
      - key: HELIUS_API_KEY
        sync: false
      - key: NODE_ENV
        value: production

databases:
  - name: opendex-db
    plan: free
```

### 4.2 Frontend Deployment
```yaml
  - type: static
    name: opendex-frontend
    buildCommand: echo "No build needed"
    staticPublishPath: ./frontend
    headers:
      - path: /*
        name: Cache-Control
        value: public, max-age=3600
```

### 4.3 Environment Variables
```
# Backend
DATABASE_URL=<from Render PostgreSQL>
HELIUS_API_KEY=<your Helius API key>
JUPITER_API_URL=https://quote-api.jup.ag/v6
CORS_ORIGIN=https://your-frontend-url.onrender.com
NODE_ENV=production

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100
```

---

## Phase 5: Security & Anti-Abuse ✅ COMPLETED

### 5.1 Vote Manipulation Prevention
- [x] Wallet signature verification for votes
- [x] One vote per wallet per submission
- [x] Token holder verification (required to vote)
- [x] Vote weighting by token holdings (1x-3x multiplier)
- [x] Minimum balance requirement (0.001% of supply)
- [x] Rate limiting on voting endpoints

### 5.2 Submission Moderation
- [x] Basic content validation
- [x] URL sanitization
- [x] Image size/format restrictions
- [x] Auto-moderation with weighted voting (+10/-10 thresholds)
- [x] 5-minute minimum review period
- [ ] Community flagging system (future)

### 5.3 API Security
- [x] CORS configuration
- [x] Rate limiting
- [x] Input validation
- [x] SQL injection prevention (parameterized queries)
- [x] XSS prevention

---

## Phase 6: Future Enhancements

### 6.1 Mobile-Responsive Improvements ✅ COMPLETED
- [x] Touch targets - minimum 44x44px for all interactive elements
- [x] Form inputs - 16px font to prevent iOS zoom
- [x] Intermediate breakpoints (360px, 480px, 600px, 768px, 900px)
- [x] Modals - mobile-friendly with max-height and overflow
- [x] Token table - horizontal scroll on mobile
- [x] Search dropdown - mobile height constraints
- [x] Safe area support for notch devices (iPhone X+)
- [x] Header/logo optimization for mobile
- [x] Footer responsive layout
- [x] Submission cards mobile layout
- [x] Stats grid - 1 column on small screens
- [x] Landscape orientation support
- [x] Reduced motion preference support
- [x] High contrast mode support

### 6.2 Token Watchlist ✅ COMPLETED
- [x] Watchlist database table with wallet-token associations
- [x] Backend API endpoints (add/remove/list/check/batch-check)
- [x] Frontend watchlist manager with local caching
- [x] Star button on token list rows
- [x] Star button on token detail page header
- [x] "Watchlist" filter tab on homepage
- [x] Empty state with call-to-action
- [x] Max 100 tokens per wallet limit
- [x] Persisted across sessions via wallet address

### 6.3 Near-term (TODO)
- [ ] WebSocket support for real-time prices
- [ ] Portfolio tracking

### 6.4 Long-term
- [ ] Multi-chain support (Ethereum, Base, etc.)
- [ ] Advanced charting (TradingView integration)
- [ ] Token alerts
- [ ] API for third-party developers
- [ ] Decentralized governance for moderation

---

## Build Order Summary

| Phase | Priority | Dependencies | Estimated Complexity |
|-------|----------|--------------|---------------------|
| 1. Foundation | HIGH | None | Low |
| 2.1-2.2 Backend Core | HIGH | Phase 1 | Medium |
| 2.3 Solana Integration | HIGH | Phase 2.1 | High |
| 2.4 API Endpoints | HIGH | Phase 2.2, 2.3 | Medium |
| 3.1 Token List UI | HIGH | Phase 2.4 | Medium |
| 3.2 Token Detail UI | HIGH | Phase 2.4 | Medium |
| 3.3 Submission System | MEDIUM | Phase 2.4, 3.2 | Medium |
| 3.4 Voting Interface | MEDIUM | Phase 3.3 | Low |
| 4. Deployment | HIGH | Phase 2, 3 | Low |
| 5. Security | HIGH | Phase 4 | Medium |
| 6. Enhancements | LOW | Phase 5 | Varies |

---

## Technology Stack Summary

| Component | Technology | Reason |
|-----------|------------|--------|
| Frontend | HTML, CSS, Vanilla JS | Simplicity, no build step |
| Backend | Node.js + Express | Easy deployment on Render |
| Database | PostgreSQL | Render native support, free tier |
| Solana RPC | Helius | Best Solana support, free tier |
| Price Data | Jupiter API | Free, comprehensive |
| Charts | Chart.js or lightweight-charts | Free, easy to use |
| Hosting | Render | Free tier, easy setup |

---

## Getting Started Commands

```bash
# After Phase 1 setup, initialize backend
cd backend
npm init -y
npm install express cors pg dotenv axios

# Start development
npm run dev
```

---

*Document Version: 1.2*
*Created: January 19, 2026*
*Last Updated: January 21, 2026*
