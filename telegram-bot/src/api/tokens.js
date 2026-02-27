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
  }
};
