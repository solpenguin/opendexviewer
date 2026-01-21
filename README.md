# OpenDexViewer

An open-source, free Solana token viewer with community-driven content.

## Features

- **Token Explorer**: Browse and search Solana tokens with real-time price data
- **Community Content**: Submit banners and social links for tokens - completely free
- **Voting System**: Community votes determine which content gets displayed
- **Open Source**: Fully transparent, MIT licensed

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Backend | Node.js + Express |
| Database | PostgreSQL |
| Hosting | Render (free tier) |
| Data Sources | Jupiter API, Helius RPC |

## Project Structure

```
opendexviewer/
├── backend/
│   ├── src/
│   │   ├── routes/         # API endpoints
│   │   ├── services/       # Business logic
│   │   └── app.js          # Express app
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── index.html          # Token list page
│   ├── token.html          # Token detail page
│   ├── submit.html         # Submission page
│   ├── css/
│   └── js/
├── render.yaml             # Render deployment config
├── BUILD_STRATEGY.md       # Development roadmap
└── README.md
```

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL (local or Render)
- Helius API key (free at https://helius.xyz)

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/SolPenguin/opendexviewer.git
   cd opendexviewer
   ```

2. **Set up the backend**
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env with your database URL and Helius API key
   npm install
   npm run dev
   ```

3. **Run the frontend**

   Open `frontend/index.html` in your browser, or use a local server:
   ```bash
   # Using Python
   cd frontend && python -m http.server 5500

   # Or using Node
   npx serve frontend
   ```

4. **Open in browser**
   - Frontend: http://localhost:5500
   - API: http://localhost:3000

## Deployment on Render

1. Fork this repository
2. Connect your GitHub to Render
3. Create a new Blueprint and select this repo
4. Render will automatically create:
   - PostgreSQL database
   - Backend web service
   - Frontend static site
5. Add your `HELIUS_API_KEY` in the backend environment variables

## API Endpoints

### Tokens
- `GET /api/tokens` - List tokens
- `GET /api/tokens/:mint` - Get token details
- `GET /api/tokens/:mint/price` - Get price data
- `GET /api/tokens/search?q=` - Search tokens

### Submissions
- `POST /api/submissions` - Create submission
- `GET /api/submissions/token/:mint` - Get submissions for token

### Votes
- `POST /api/votes` - Cast vote
- `GET /api/votes/submission/:id` - Get vote counts

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Data Sources

- **Jupiter API** - Token prices, metadata, swap routing
- **Helius RPC** - Solana blockchain data, token metadata
- **GeckoTerminal API** - Pool data, OHLCV charts, trending tokens

## License

MIT License - see [LICENSE](LICENSE) for details.

## Credits

Created by The Sol Penguin

---

*OpenDex is an independent, community-driven project.*
