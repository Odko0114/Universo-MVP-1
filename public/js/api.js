/* Universo API client. Auth is via an httpOnly cookie (set by the server), so
   there is no token to store client-side — every request just sends credentials. */
(function () {
  "use strict";

  async function request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers,
        credentials: "same-origin",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Network error — is the server running?");
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

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
      if (v !== undefined && v !== null && v !== "") q.set(k, v);
    });
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  // First-party behavioral beacon (pageview / profile_view / filter_used).
  // Fire-and-forget: never throws, never blocks navigation. Uses sendBeacon
  // where available so it survives the page unloading mid-navigation.
  function track(payload) {
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        const ok = navigator.sendBeacon(
          "/api/track",
          new Blob([body], { type: "application/json" }),
        );
        if (ok) return;
      }
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
        body,
      }).catch(() => {});
    } catch {
      /* analytics must never break the app */
    }
  }

  window.API = {
    track,
    // Auth
    register: (payload) => request("POST", "/auth/register", payload),
    login: (payload) => request("POST", "/auth/login", payload),
    logout: () => request("POST", "/auth/logout"),
    me: () => request("GET", "/auth/me"),
    updateProfile: (payload) => request("PATCH", "/me/profile", payload),
    exportData: () => request("GET", "/me/export"),
    deleteAccount: () => request("DELETE", "/me"),
    logoutEverywhere: () => request("POST", "/me/logout-everywhere"),
    verifyEmail: (token) => request("POST", "/auth/verify-email", { token }),
    resendVerification: () => request("POST", "/me/resend-verification"),
    changeEmail: (new_email, password) =>
      request("POST", "/me/change-email", { new_email, password }),
    forgotPassword: (email) =>
      request("POST", "/auth/forgot-password", { email }),
    resetPassword: (token, password) =>
      request("POST", "/auth/reset-password", { token, password }),
    // Universities
    filters: () => request("GET", "/universities/filters"),
    universities: (params) => request("GET", `/universities${toQuery(params)}`),
    university: (id) =>
      request("GET", `/universities/${encodeURIComponent(id)}`),
    applyClick: (id) =>
      request("POST", `/universities/${encodeURIComponent(id)}/apply-click`),
    photo: (id) =>
      request("GET", `/universities/${encodeURIComponent(id)}/photo`),
    // Saved
    saved: () => request("GET", "/me/saved"),
    save: (id) => request("POST", `/me/saved/${encodeURIComponent(id)}`),
    unsave: (id) => request("DELETE", `/me/saved/${encodeURIComponent(id)}`),
    setApplicationStatus: (id, status) =>
      request("POST", `/me/saved/${encodeURIComponent(id)}/status`, { status }),
    recommendations: (limit) =>
      request("GET", `/me/recommendations${toQuery({ limit })}`),
    journey: () => request("GET", "/me/journey"),
    toggleMilestone: (key, done) =>
      request("POST", "/me/milestone", { key, done }),
    updateDream: (payload) => request("PATCH", "/me/dream", payload),
    updateNotifications: (payload) =>
      request("PATCH", "/me/notifications", payload),
    toggleDocument: (key, done) =>
      request("POST", "/me/document", { key, done }),
    scholarships: () => request("GET", "/scholarships"),
    setScholarshipStatus: (key, status) =>
      request("POST", "/me/scholarship", { key, status }),
    setScholarship: (key, patch) =>
      request("POST", "/me/scholarship", { key, ...patch }),
    setDocExpiry: (key, expiry) =>
      request("POST", "/me/document/expiry", { key, expiry }),
    // Applications (per-university document tracking)
    patchApplication: (id, patch) =>
      request("POST", `/me/application/${encodeURIComponent(id)}`, patch),
    setRequirement: (id, key, level) =>
      request("POST", `/me/application/${encodeURIComponent(id)}/requirement`, {
        key,
        level,
      }),
    toggleAppDocument: (id, key, done) =>
      request("POST", `/me/application/${encodeURIComponent(id)}/document`, {
        key,
        done,
      }),
    addCustomDoc: (id, label) =>
      request("POST", `/me/application/${encodeURIComponent(id)}/custom`, {
        label,
      }),
    patchCustomDoc: (id, cid, patch) =>
      request(
        "POST",
        `/me/application/${encodeURIComponent(id)}/custom/${encodeURIComponent(cid)}`,
        patch,
      ),
    removeCustomDoc: (id, cid) =>
      request(
        "DELETE",
        `/me/application/${encodeURIComponent(id)}/custom/${encodeURIComponent(cid)}`,
      ),
    // Logo served through our caching proxy (no third-party hotlinking).
    logoUrl: (domain) => `/api/logo?domain=${encodeURIComponent(domain)}`,
  };
})();
