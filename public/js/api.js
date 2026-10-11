/* Thin wrapper over the local server's JSON API. */

async function request(method, url, body, headers = {}) {
  const options = { method, headers: { ...headers } };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

export const api = {
  getConfig: () => request('GET', '/api/config'),
  setConfig: (patch) => request('PUT', '/api/config', patch),

  listLibrary: () => request('GET', '/api/library'),
  readCard: (path) => request('GET', `/api/card?path=${encodeURIComponent(path)}`),
  writeCard: (path, card) => request('PUT', `/api/card?path=${encodeURIComponent(path)}`, card),
  deleteEntry: (path) => request('DELETE', `/api/card?path=${encodeURIComponent(path)}`),
  createFolder: (path) => request('POST', '/api/folder', { path }),
  move: (from, to) => request('POST', '/api/move', { from, to }),

  imageFromUrl: (url, name) => request('POST', '/api/image/url', { url, name }),
  imageFromBlob: (blob, name) =>
    request('POST', `/api/image/blob?name=${encodeURIComponent(name || 'pasted')}`, blob, {
      'Content-Type': blob.type || 'image/png',
    }),

  exportPng: (payload) => request('POST', '/api/export', payload),
  exportBatch: (payload) => request('POST', '/api/export/batch', payload),
  exportIndex: (payload) => request('POST', '/api/export/index', payload),
  importTable: (payload) => request('POST', '/api/import', payload),
  buildTts: (payload) => request('POST', '/api/tts', payload),
};
