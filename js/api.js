const OpsApi = (() => {
  function getToken() {
    return localStorage.getItem("ops_token");
  }

  function getTeam() {
    try {
      return JSON.parse(localStorage.getItem("ops_team") || "null");
    } catch {
      return null;
    }
  }

  function setSession(token, team) {
    localStorage.setItem("ops_token", token);
    localStorage.setItem("ops_team", JSON.stringify(team));
  }

  function clearSession() {
    localStorage.removeItem("ops_token");
    localStorage.removeItem("ops_team");
  }

  async function request(path, { method = "GET", body, isCsv = false } = {}) {
    const headers = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body && !isCsv) headers["Content-Type"] = "application/json";
    if (isCsv) headers["Content-Type"] = "text/plain";

    const res = await fetch(`${window.OPS_API_BASE_URL}${path}`, {
      method,
      headers,
      body: body ? (isCsv ? body : JSON.stringify(body)) : undefined,
    });

    if (res.status === 401) {
      clearSession();
      window.location.href = "index.html";
      throw new Error("Session expired.");
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  return {
    getToken,
    getTeam,
    setSession,
    clearSession,
    login: (teamName, pin) => request("/api/auth/login", { method: "POST", body: { teamName, pin } }),
    logout: () => request("/api/auth/logout", { method: "POST" }),

    listRegistrations: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/api/registrations${qs ? `?${qs}` : ""}`);
    },
    getRegistration: (id) => request(`/api/registrations/${id}`),
    patchRegistration: (id, body) => request(`/api/registrations/${id}`, { method: "PATCH", body }),

    logVisit: (body) => request("/api/visits", { method: "POST", body }),
    listVisits: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/api/visits${qs ? `?${qs}` : ""}`);
    },

    listFieldReports: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/api/field-reports${qs ? `?${qs}` : ""}`);
    },
    getFieldReport: (id) => request(`/api/field-reports/${id}`),
    createFieldReport: (body) => request("/api/field-reports", { method: "POST", body }),
    fieldReportPhotoUrl: (reportId, photoId) =>
      `${window.OPS_API_BASE_URL}/api/field-reports/${reportId}/photos/${photoId}`,
    fetchAuthorizedBlob: async (path) => {
      const token = getToken();
      const res = await fetch(`${window.OPS_API_BASE_URL}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 401) {
        clearSession();
        window.location.href = "index.html";
        throw new Error("Session expired.");
      }
      if (!res.ok) throw new Error("Could not load photo.");
      return res.blob();
    },

    getLeaderboard: () => request("/api/leaderboard"),

    pingLocation: (lat, lng) => request("/api/teams/me/location", { method: "PUT", body: { lat, lng } }),
    getTeamLocations: () => request("/api/teams/locations"),
    listTeams: () => request("/api/teams"),
    createTeam: (name, pin) => request("/api/teams", { method: "POST", body: { name, pin } }),

    adminSync: () => request("/api/admin/sync", { method: "POST" }),
    adminSyncCsv: (csvText) => request("/api/admin/sync/csv", { method: "POST", body: csvText, isCsv: true }),
    adminGeocode: () => request("/api/admin/geocode", { method: "POST", body: {} }),
    adminGeocodeQueue: () => request("/api/admin/geocode/queue"),
    adminLocationSearch: (q) =>
      request(`/api/admin/location-search?q=${encodeURIComponent(q)}`),
    // Shared route: available to field teams as well as admins.
    locationSearch: (q) => request(`/api/location-search?q=${encodeURIComponent(q)}`),
    adminCreateRegistration: (body) =>
      request("/api/admin/registrations", { method: "POST", body }),
    adminStats: () => request("/api/admin/stats"),
  };
})();
