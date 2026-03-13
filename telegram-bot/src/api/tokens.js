const client = require('./client');

module.exports = {
  async getToken(mint) {
    const { data } = await client.get(`/api/tokens/${mint}`);
    return data;
  },

  async getPrice(mint) {
    const { data } = await client.get(`/api/tokens/${mint}/price`);
    return data;
  },

  async searchTokens(query) {
    const { data } = await client.get('/api/tokens/search', { params: { q: query } });
    return data;
  },

  async batchGetTokens(mints) {
    const { data } = await client.post('/api/tokens/batch', { mints });
    return data;
  },

  async getSubmissions(mint) {
    const { data } = await client.get(`/api/tokens/${mint}/submissions`);
    return data;
  },

  async getSimilarTokens(mint) {
    const { data } = await client.get(`/api/tokens/${mint}/similar`);
    return data;
  },

  async leaderboardWatchlist(params = {}) {
    const { data } = await client.get('/api/tokens/leaderboard/watchlist', { params });
    return data;
  },

  async leaderboardSentiment(params = {}) {
    const { data } = await client.get('/api/tokens/leaderboard/sentiment', { params });
    return data;
  },

  async leaderboardCalls(params = {}) {
    const { data } = await client.get('/api/tokens/leaderboard/calls', { params });
    return data;
  },

  async getSentiment(mint) {
    const { data } = await client.get(`/api/sentiment/${mint}`);
    return data;
  },

  async ogfinderSearch(query) {
    const { data } = await client.get('/api/ogfinder/search', { params: { q: query } });
    return data;
  },

  async getDailyBrief(params = {}) {
    const { data } = await client.get('/api/daily-brief', { params });
    return data;
  }
};
