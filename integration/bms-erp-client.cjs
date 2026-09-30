'use strict';

// Optional server-side adapter for BMS ERP. Keep the API key on the ERP backend.
function createMailInboxClient({ baseUrl, apiKey, timeoutMs = 3000 }) {
  if (!baseUrl || !apiKey) throw new Error('Mail inbox URL and API key are required');
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid mail inbox URL');
  }
  const root = base.href.replace(/\/+$/, '');

  async function request(path, { method = 'GET', body } = {}) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch(root + path, {
        method,
        headers: { 'X-API-Key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || `Mail inbox returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    listAddresses: () => request('/api/erp/addresses'),
    createAddress: (localPart, label = '') => request('/api/erp/addresses', { method: 'POST', body: { localPart, label } }),
    latestCode: (address, since = Date.now() - 10 * 60_000) => request(`/api/erp/codes/latest?${new URLSearchParams({ address, since: String(since) })}`),
  };
}

module.exports = { createMailInboxClient };
