/* Universo API client. Auth is via an httpOnly cookie (set by the server), so
   there is no token to store client-side — every request just sends credentials. */
(function () {
  'use strict';

  async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Network error — is the server running?');
    }

    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }

    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status}).`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toQuery(params) {
    const q = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') q.set(k, v);
    });
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  // First-party behavioral beacon (pageview / profile_view / filter_used).
  // Fire-and-forget: never throws, never blocks navigation. Uses sendBeacon
  // where available so it survives the page unloading mid-navigation.
  function track(payload) {
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        const ok = navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
        if (ok) return;
      }
      fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true, body }).catch(() => {});
    } catch { /* analytics must never break the app */ }
  }

  window.API = {
    track,
    // Auth
    register: (payload) => request('POST', '/auth/register', payload),
    login: (payload) => request('POST', '/auth/login', payload),
    logout: () => request('POST', '/auth/logout'),
    me: () => request('GET', '/auth/me'),
    updateProfile: (payload) => request('PATCH', '/me/profile', payload),
    exportData: () => request('GET', '/me/export'),
    deleteAccount: () => request('DELETE', '/me'),
    logoutEverywhere: () => request('POST', '/me/logout-everywhere'),
    // Universities
    filters: () => request('GET', '/universities/filters'),
    universities: (params) => request('GET', `/universities${toQuery(params)}`),
    university: (id) => request('GET', `/universities/${encodeURIComponent(id)}`),
    applyClick: (id) => request('POST', `/universities/${encodeURIComponent(id)}/apply-click`),
    photo: (id) => request('GET', `/universities/${encodeURIComponent(id)}/photo`),
    // Saved
    saved: () => request('GET', '/me/saved'),
    save: (id) => request('POST', `/me/saved/${encodeURIComponent(id)}`),
    unsave: (id) => request('DELETE', `/me/saved/${encodeURIComponent(id)}`),
    recommendations: (limit) => request('GET', `/me/recommendations${toQuery({ limit })}`),
    // Logo served through our caching proxy (no third-party hotlinking).
    logoUrl: (domain) => `/api/logo?domain=${encodeURIComponent(domain)}`,
  };
})();
