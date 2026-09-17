// ---------- Auth guard ----------
if (!OpsApi.getToken()) window.location.href = "index.html";
const ME = OpsApi.getTeam() || {};

document.getElementById("team-badge").textContent = ME.name || "Team";
if (ME.isAdmin) document.getElementById("admin-nav-btn").style.display = "flex";

lucide.createIcons();

// ---------- Toast ----------
function toast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => (el.className = "toast"), 3200);
}

// ---------- View switching ----------
const VIEW_TITLES = { map: "Map", reports: "Reports", leaderboard: "Leaderboard", admin: "Admin" };
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
  document.querySelectorAll(".nav-btn[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.getElementById("view-title").textContent = VIEW_TITLES[name];
  if (name === "map") setTimeout(() => map.invalidateSize(), 50);
  if (name === "reports") loadReportsView();
  if (name === "leaderboard") loadLeaderboard();
  if (name === "admin") loadAdmin();
}
document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});
document.getElementById("logout-btn").addEventListener("click", async () => {
  try { await OpsApi.logout(); } catch {}
  OpsApi.clearSession();
  window.location.href = "index.html";
});

// ---------- Geolocation helper ----------
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported on this device."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error("Couldn't get your GPS location: " + err.message)),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

// ==================================================================
// MAP VIEW
// ==================================================================
const BHOPAL = [23.2599, 77.4126];
const map = L.map("map", { zoomControl: false }).setView(BHOPAL, 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19,
}).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);

const STATUS_COLOR = {
  open: "#F5720C",
  in_progress: "#2563EB",
  done: "#16A34A",
  skipped: "#78716C",
};

function pinIcon(status) {
  return L.divIcon({
    className: "",
    html: `<div class="pin-dot" style="background:${STATUS_COLOR[status] || "#999"}"></div>`,
    // .pin-dot is 28px rotated -45deg, so its point lands 28/2 * sqrt(2) below
    // the box centre -- anchor there so the tip marks the actual location.
    iconSize: [28, 28],
    iconAnchor: [14, 33],
  });
}
function teamDotIcon() {
  return L.divIcon({ className: "", html: `<div class="team-dot"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
}
function streetDotIcon() {
  return L.divIcon({ className: "", html: `<div class="street-dot"></div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}
function reportDotIcon() {
  return L.divIcon({ className: "", html: `<div class="report-dot"></div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}

let regMarkers = new Map(); // id -> marker
let teamMarkers = new Map(); // teamId -> marker
let streetMarkers = new Map(); // visit id -> marker
let reportMarkers = new Map(); // field report id -> marker
let currentStatusFilter = "";
let registrationsCache = [];
let fieldReportsCache = [];

async function loadRegistrations() {
  try {
    const params = currentStatusFilter ? { status: currentStatusFilter } : {};
    registrationsCache = await OpsApi.listRegistrations(params);
    renderRegistrationMarkers();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderRegistrationMarkers() {
  regMarkers.forEach((m) => map.removeLayer(m));
  regMarkers.clear();

  registrationsCache.forEach((reg) => {
    if (reg.lat == null || reg.lng == null) return; // needs_pin -- admin handles these
    const marker = L.marker([reg.lat, reg.lng], { icon: pinIcon(reg.status) }).addTo(map);
    marker.on("click", () => openPinSheet(reg.id));
    regMarkers.set(reg.id, marker);
  });
}

// Street-dog visits have no registration row, so they are drawn from the visit
// log itself -- otherwise a logged stray leaves no mark on the map.
async function loadStreetVisits() {
  try {
    const visits = await OpsApi.listVisits();
    streetMarkers.forEach((m) => map.removeLayer(m));
    streetMarkers.clear();

    // These are always completed work, so hide them unless the filter includes done.
    if (currentStatusFilter && currentStatusFilter !== "done") return;

    visits.forEach((visit) => {
      if (visit.registration_id != null) return;
      if (visit.lat == null || visit.lng == null) return;
      const when = new Date(visit.created_at).toLocaleString();
      const marker = L.marker([visit.lat, visit.lng], { icon: streetDotIcon() })
        .bindPopup(
          `<strong>${visit.dogs_vaccinated} street dog(s)</strong><br>${escapeHtml(visit.notes || "No notes")}<br><span style="color:#A8988A">${escapeHtml(when)}</span>`
        )
        .addTo(map);
      streetMarkers.set(visit.id, marker);
    });
  } catch {
    /* non-critical, fail silently */
  }
}

async function loadFieldReportMarkers() {
  try {
    fieldReportsCache = await OpsApi.listFieldReports({ source: "mission_rabies" });
    reportMarkers.forEach((m) => map.removeLayer(m));
    reportMarkers.clear();
    fieldReportsCache.forEach((report) => {
      if (report.lat == null || report.lng == null) return;
      const marker = L.marker([report.lat, report.lng], { icon: reportDotIcon() })
        .on("click", () => openReportDetail(report.id));
      marker.addTo(map);
      reportMarkers.set(report.id, marker);
    });
  } catch {
    /* non-critical */
  }
}

async function loadTeamLocations() {
  try {
    const locations = await OpsApi.getTeamLocations();
    teamMarkers.forEach((m) => map.removeLayer(m));
    teamMarkers.clear();
    locations.forEach((loc) => {
      if (loc.teamId === ME.id) return; // don't show my own dot to myself
      const marker = L.marker([loc.lat, loc.lng], { icon: teamDotIcon(), zIndexOffset: 500 })
        .bindTooltip(loc.teamName, { direction: "top" })
        .addTo(map);
      teamMarkers.set(loc.teamId, marker);
    });
  } catch {
    /* non-critical, fail silently */
  }
}

// Filter chips
document.getElementById("filter-bar").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  currentStatusFilter = chip.dataset.status || "";
  loadRegistrations();
  loadStreetVisits();
});

// Heartbeat: report my own location every 45s so other teams see me.
async function heartbeat() {
  try {
    const pos = await getCurrentPosition();
    await OpsApi.pingLocation(pos.lat, pos.lng);
  } catch {
    /* location denied / unavailable -- ignore quietly */
  }
}
heartbeat();
setInterval(heartbeat, 45000);
setInterval(loadTeamLocations, 20000);
loadTeamLocations();
loadRegistrations();
loadStreetVisits();
loadFieldReportMarkers();

// ==================================================================
// PIN DETAIL SHEET
// ==================================================================
const pinSheet = document.getElementById("pin-sheet");
const sheetBackdrop = document.getElementById("sheet-backdrop");

function openSheetEl(sheetEl, backdropEl) {
  backdropEl.classList.add("active");
  sheetEl.classList.add("active");
}
function closeSheetEl(sheetEl, backdropEl) {
  backdropEl.classList.remove("active");
  sheetEl.classList.remove("active");
}
sheetBackdrop.addEventListener("click", () => closeSheetEl(pinSheet, sheetBackdrop));

const TEMPERAMENT_LABEL = { Friendly: "🟢 Friendly", "Semi-aggressive": "🟡 Semi-aggressive", Aggressive: "🔴 Aggressive", Unsure: "⚪ Unsure" };

async function openPinSheet(regId) {
  const reg = registrationsCache.find((r) => r.id === regId) || (await OpsApi.getRegistration(regId));
  renderPinSheet(reg);
  openSheetEl(pinSheet, sheetBackdrop);
}

function renderPinSheet(reg, mode = "view") {
  const digits = (reg.contact_number || "").replace(/\D/g, "");
  const wa = (reg.whatsapp_number || reg.contact_number || "").replace(/\D/g, "");

  let actionsHtml = "";
  if (mode === "view") {
    actionsHtml = `
      <div class="action-grid">
        <a class="btn btn-outline" href="tel:${digits}"><i data-lucide="phone" style="width:14px;height:14px;"></i>Call</a>
        <a class="btn btn-outline" target="_blank" href="https://wa.me/91${wa}"><i data-lucide="message-circle" style="width:14px;height:14px;"></i>WhatsApp</a>
        <a class="btn btn-outline btn-full" target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${reg.lat},${reg.lng}">
          <i data-lucide="navigation" style="width:14px;height:14px;"></i>Navigate
        </a>
        ${reg.status !== "done" && reg.status !== "skipped" ? `
          <button class="btn btn-primary" id="btn-start">Start visit</button>
          <button class="btn btn-danger" id="btn-skip">Skip</button>
          <button class="btn btn-primary btn-full" id="btn-done">Mark done</button>
        ` : `<p class="muted btn-full" style="text-align:center;">This site is ${reg.status}.</p>`}
        ${ME.isAdmin ? `
          <button class="btn btn-outline btn-full" id="btn-fix-pin">
            <i data-lucide="move" style="width:14px;height:14px;"></i>Fix pin location
          </button>
        ` : ""}
      </div>`;
  } else if (mode === "done") {
    actionsHtml = `
      <label class="field-label">Dogs vaccinated here</label>
      <input class="field-input" id="done-count" type="number" min="1" value="${reg.dog_count || 1}" />
      <p id="done-error" style="color:#9F1239; font-size:13px; font-weight:600; display:none;"></p>
      <div class="action-grid">
        <button class="btn btn-ghost" id="btn-cancel">Cancel</button>
        <button class="btn btn-primary" id="btn-confirm-done">Confirm</button>
      </div>`;
  } else if (mode === "skip") {
    actionsHtml = `
      <label class="field-label">Why skip this one?</label>
      <input class="field-input" id="skip-reason" placeholder="e.g. no one home, dog too aggressive today" />
      <div class="action-grid">
        <button class="btn btn-ghost" id="btn-cancel">Cancel</button>
        <button class="btn btn-danger" id="btn-confirm-skip">Confirm skip</button>
      </div>`;
  }

  pinSheet.innerHTML = `
    <div class="sheet-handle"></div>
    <span class="status-pill" style="background:${STATUS_COLOR[reg.status]}">${reg.status.replace("_", " ")}</span>
    <h3 style="margin: 10px 0 2px; font-size: 18px; font-weight: 800;">${escapeHtml(reg.full_name || "Unnamed")}</h3>
    <p class="muted" style="margin:0 0 10px;">${escapeHtml(reg.address || "")}</p>

    <div class="info-row"><span class="label">Dogs expected</span><span class="value">${reg.dog_count ?? "-"}</span></div>
    <div class="info-row"><span class="label">Location of dog(s)</span><span class="value">${escapeHtml(reg.dog_location || "-")}</span></div>
    <div class="info-row"><span class="label">Temperament</span><span class="value">${TEMPERAMENT_LABEL[reg.temperament] || reg.temperament || "-"}</span></div>
    <div class="info-row"><span class="label">Dewormed?</span><span class="value">${reg.deworm_status || "-"}</span></div>
    ${reg.health_concerns ? `<div class="info-row"><span class="label">Health notes</span><span class="value">${escapeHtml(reg.health_concerns)}</span></div>` : ""}

    ${actionsHtml}
  `;
  lucide.createIcons();

  pinSheet.querySelector("#btn-start")?.addEventListener("click", async () => {
    try {
      const updated = await OpsApi.patchRegistration(reg.id, { status: "in_progress" });
      Object.assign(reg, updated);
      updateLocalRegistration(updated);
      renderPinSheet(reg);
      toast("Marked in progress.");
    } catch (err) { toast(err.message, true); }
  });

  // Admin-only: correct a pin Nominatim placed in the wrong spot. Reuses the
  // same map-click sheet as the needs_pin queue; the PATCH route already
  // rejects lat/lng changes from non-admin teams.
  pinSheet.querySelector("#btn-fix-pin")?.addEventListener("click", () => {
    closeSheetEl(pinSheet, sheetBackdrop);
    openPinDropMap(reg.id, reg);
  });

  pinSheet.querySelector("#btn-skip")?.addEventListener("click", () => renderPinSheet(reg, "skip"));
  pinSheet.querySelector("#btn-done")?.addEventListener("click", () => renderPinSheet(reg, "done"));
  pinSheet.querySelector("#btn-cancel")?.addEventListener("click", () => renderPinSheet(reg, "view"));

  pinSheet.querySelector("#btn-confirm-skip")?.addEventListener("click", async () => {
    const reason = pinSheet.querySelector("#skip-reason").value.trim();
    try {
      const updated = await OpsApi.patchRegistration(reg.id, { status: "skipped", skipReason: reason || null });
      Object.assign(reg, updated);
      updateLocalRegistration(updated);
      renderPinSheet(reg);
      toast("Site skipped.");
    } catch (err) { toast(err.message, true); }
  });

  pinSheet.querySelector("#btn-confirm-done")?.addEventListener("click", async () => {
    const errorEl = pinSheet.querySelector("#done-error");
    const count = Number(pinSheet.querySelector("#done-count").value);
    if (!count || count <= 0) {
      errorEl.textContent = "Enter how many dogs were vaccinated.";
      errorEl.style.display = "block";
      return;
    }
    try {
      const pos = await getCurrentPosition();
      const updated = await OpsApi.logVisit({ registrationId: reg.id, dogsVaccinated: count, lat: pos.lat, lng: pos.lng });
      const freshReg = await OpsApi.getRegistration(reg.id);
      Object.assign(reg, freshReg);
      updateLocalRegistration(freshReg);
      renderPinSheet(reg);
      toast(`Logged ${count} dog(s) vaccinated. 🎉`);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
    }
  });
}

function updateLocalRegistration(updated) {
  const idx = registrationsCache.findIndex((r) => r.id === updated.id);
  if (idx >= 0) registrationsCache[idx] = updated;
  const marker = regMarkers.get(updated.id);
  if (marker) marker.setIcon(pinIcon(updated.status));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ==================================================================
// LOG STREET-DOG VISIT (no registration)
// ==================================================================
const streetSheet = document.getElementById("street-sheet");
const streetBackdrop = document.getElementById("street-backdrop");

// null means "read my GPS when saving" -- the original behaviour. Set to a
// latlng when the team picks a spot on the map instead.
let streetLocation = null;

function setStreetLocationStatus(text) {
  document.getElementById("street-location-status").textContent = text;
}

document.getElementById("log-street-btn").addEventListener("click", () => {
  document.getElementById("street-dog-count").value = "";
  document.getElementById("street-notes").value = "";
  document.getElementById("street-error").style.display = "none";
  streetLocation = null;
  setStreetLocationStatus("Using your current GPS location.");
  openSheetEl(streetSheet, streetBackdrop);
  lucide.createIcons();
});

document.getElementById("street-use-gps").addEventListener("click", () => {
  streetLocation = null;
  setStreetLocationStatus("Using your current GPS location.");
});

document.getElementById("street-pick-location").addEventListener("click", () => {
  const notes = document.getElementById("street-notes").value.trim();
  openPinDropMap(null, { address: notes }, (latlng) => {
    streetLocation = latlng;
    setStreetLocationStatus(`Picked on map: ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`);
  });
});
document.getElementById("street-cancel").addEventListener("click", () => closeSheetEl(streetSheet, streetBackdrop));
streetBackdrop.addEventListener("click", () => closeSheetEl(streetSheet, streetBackdrop));

document.getElementById("street-save").addEventListener("click", async () => {
  const errorEl = document.getElementById("street-error");
  const count = Number(document.getElementById("street-dog-count").value);
  const notes = document.getElementById("street-notes").value.trim();

  if (!count || count <= 0) {
    errorEl.textContent = "Enter how many dogs were vaccinated.";
    errorEl.style.display = "block";
    return;
  }
  try {
    // Fall back to GPS only when the team has not picked a spot on the map.
    const pos = streetLocation || (await getCurrentPosition());
    await OpsApi.logVisit({ dogsVaccinated: count, notes: notes || null, lat: pos.lat, lng: pos.lng });
    closeSheetEl(streetSheet, streetBackdrop);
    toast(`Logged ${count} street dog(s). 🎉`);
    loadStreetVisits();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  }
});

// ==================================================================
// FIELD REPORTS (rescue / medication / unsterilized / notes)
// ==================================================================
const REPORT_KIND_LABEL = {
  rescue_needed: "Needs rescue",
  medication_needed: "Needs medication",
  unsterilized: "Not sterilized",
  observation: "Observation",
};
const reportFormSheet = document.getElementById("report-form-sheet");
const reportFormBackdrop = document.getElementById("report-form-backdrop");
const reportDetailSheet = document.getElementById("report-detail-sheet");
const reportDetailBackdrop = document.getElementById("report-detail-backdrop");

let reportLocation = null;
let reportPhotos = [];
let reportKindFilter = "";

function setReportLocationStatus(text) {
  document.getElementById("report-location-status").textContent = text;
}

function toggleAnimalOther() {
  const other = document.getElementById("report-animal").value === "other";
  document.getElementById("report-animal-other").style.display = other ? "block" : "none";
  document.querySelector("label[for='report-animal-other']").style.display = other ? "block" : "none";
}

function resetReportForm() {
  document.getElementById("report-kind").value = "rescue_needed";
  document.getElementById("report-animal").value = "dog";
  document.getElementById("report-animal-other").value = "";
  document.getElementById("report-size").value = "medium";
  document.getElementById("report-landmark").value = "";
  document.getElementById("report-remarks").value = "";
  document.getElementById("report-photos").value = "";
  document.getElementById("report-photo-preview").innerHTML = "";
  document.getElementById("report-form-error").style.display = "none";
  reportPhotos = [];
  reportLocation = null;
  setReportLocationStatus("Using your current GPS location.");
  toggleAnimalOther();
}

function openReportForm() {
  resetReportForm();
  openSheetEl(reportFormSheet, reportFormBackdrop);
  lucide.createIcons();
}

document.getElementById("report-animal-btn").addEventListener("click", openReportForm);
document.getElementById("reports-add-btn").addEventListener("click", openReportForm);
document.getElementById("report-form-cancel").addEventListener("click", () => closeSheetEl(reportFormSheet, reportFormBackdrop));
reportFormBackdrop.addEventListener("click", () => closeSheetEl(reportFormSheet, reportFormBackdrop));
document.getElementById("report-animal").addEventListener("change", toggleAnimalOther);
toggleAnimalOther();

document.getElementById("report-use-gps").addEventListener("click", () => {
  reportLocation = null;
  setReportLocationStatus("Using your current GPS location.");
});
document.getElementById("report-pick-location").addEventListener("click", () => {
  const landmark = document.getElementById("report-landmark").value.trim();
  openPinDropMap(null, { address: landmark }, (latlng) => {
    reportLocation = latlng;
    setReportLocationStatus(`Picked on map: ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`);
  });
});

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1280;
      let w = img.width;
      let h = img.height;
      if (w > max || h > max) {
        const scale = max / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      resolve({ mimeType: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that photo."));
    };
    img.src = url;
  });
}

document.getElementById("report-photos").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []).slice(0, 3);
  const preview = document.getElementById("report-photo-preview");
  preview.innerHTML = "";
  reportPhotos = [];
  try {
    for (const file of files) {
      const photo = await compressImageFile(file);
      reportPhotos.push({ mimeType: photo.mimeType, data: photo.data });
      const img = document.createElement("img");
      img.src = photo.preview;
      img.alt = "Selected photo";
      preview.appendChild(img);
    }
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById("report-form-save").addEventListener("click", async () => {
  const errorEl = document.getElementById("report-form-error");
  errorEl.style.display = "none";
  try {
    const pos = reportLocation || (await getCurrentPosition());
    await OpsApi.createFieldReport({
      source: "mission_rabies",
      reportKind: document.getElementById("report-kind").value,
      animalType: document.getElementById("report-animal").value,
      animalTypeOther: document.getElementById("report-animal-other").value.trim(),
      sizeCategory: document.getElementById("report-size").value,
      landmark: document.getElementById("report-landmark").value.trim(),
      remarks: document.getElementById("report-remarks").value.trim(),
      lat: pos.lat,
      lng: pos.lng,
      photos: reportPhotos,
    });
    closeSheetEl(reportFormSheet, reportFormBackdrop);
    toast("Field report saved.");
    loadReportsView();
    loadFieldReportMarkers();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  }
});

async function loadReportsView() {
  loadNeedsPinList();
  await loadReportsList();
}

async function loadReportsList() {
  const wrap = document.getElementById("reports-list");
  const q = document.getElementById("report-search").value.trim();
  const params = { source: "mission_rabies" };
  if (reportKindFilter) params.kind = reportKindFilter;
  const animal = document.getElementById("report-animal-filter").value;
  const size = document.getElementById("report-size-filter").value;
  if (animal) params.animalType = animal;
  if (size) params.size = size;
  if (q) params.q = q;

  try {
    const rows = await OpsApi.listFieldReports(params);
    if (!rows.length) {
      wrap.innerHTML = `<p class="muted">No field reports match these filters.</p>`;
      return;
    }
    wrap.innerHTML = rows
      .map(
        (r) => `
      <button class="card report-card-btn" data-id="${r.id}" style="width:100%; text-align:left; font:inherit; color:inherit;">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
          <span class="report-kind-pill">${escapeHtml(REPORT_KIND_LABEL[r.report_kind] || r.report_kind)}</span>
          <span class="muted">${escapeHtml(new Date(r.created_at).toLocaleString())}</span>
        </div>
        <div style="font-weight:700; margin-top:6px;">${escapeHtml(r.animal_type === "other" ? r.animal_type_other || "Other animal" : r.animal_type)} · ${escapeHtml(r.size_category)}</div>
        <div class="muted">${escapeHtml(r.landmark || "No landmark")} · ${r.photo_count} photo(s)</div>
        ${r.remarks ? `<div style="margin-top:6px; font-size:13px;">${escapeHtml(r.remarks)}</div>` : ""}
      </button>`
      )
      .join("");
    wrap.querySelectorAll(".report-card-btn").forEach((btn) => {
      btn.addEventListener("click", () => openReportDetail(Number(btn.dataset.id)));
    });
  } catch (err) {
    wrap.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById("report-filter-bar").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#report-filter-bar .chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  reportKindFilter = chip.dataset.kind || "";
  loadReportsList();
});
document.getElementById("report-animal-filter").addEventListener("change", loadReportsList);
document.getElementById("report-size-filter").addEventListener("change", loadReportsList);
document.getElementById("report-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    loadReportsList();
  }
});

async function openReportDetail(id) {
  try {
    const report = await OpsApi.getFieldReport(id);
    const photosHtml = report.photos?.length
      ? `<div class="photo-row" id="report-detail-photos"></div>`
      : `<p class="muted">No photos attached.</p>`;
    reportDetailSheet.innerHTML = `
      <div class="sheet-handle"></div>
      <span class="report-kind-pill">${escapeHtml(REPORT_KIND_LABEL[report.report_kind] || report.report_kind)}</span>
      <p style="font-weight:800; font-size:16px; margin:8px 0 4px;">${escapeHtml(report.animal_type === "other" ? report.animal_type_other || "Other animal" : report.animal_type)} · ${escapeHtml(report.size_category)}</p>
      <p class="muted" style="margin:0 0 10px;">${escapeHtml(report.recorded_by_team_name || "Unknown team")} · ${escapeHtml(new Date(report.created_at).toLocaleString())}</p>
      <div class="info-row"><span class="label">Landmark</span><span class="value">${escapeHtml(report.landmark || "—")}</span></div>
      <div class="info-row"><span class="label">Coordinates</span><span class="value">${Number(report.lat).toFixed(5)}, ${Number(report.lng).toFixed(5)}</span></div>
      <p style="margin:12px 0;">${escapeHtml(report.remarks || "No remarks.")}</p>
      ${photosHtml}
      <button class="btn btn-ghost btn-full" id="report-detail-close">Close</button>
    `;
    openSheetEl(reportDetailSheet, reportDetailBackdrop);
    document.getElementById("report-detail-close").addEventListener("click", () =>
      closeSheetEl(reportDetailSheet, reportDetailBackdrop)
    );
    if (report.photos?.length) {
      const row = document.getElementById("report-detail-photos");
      for (const photo of report.photos) {
        const img = document.createElement("img");
        img.alt = "Field report photo";
        // Cloudinary (and any other https) URLs can be shown directly. Legacy
        // rows still use the authenticated API proxy.
        if (/^https?:\/\//i.test(photo.url)) {
          img.src = photo.url;
        } else {
          const blob = await OpsApi.fetchAuthorizedBlob(photo.url);
          img.src = URL.createObjectURL(blob);
        }
        row.appendChild(img);
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
}
reportDetailBackdrop.addEventListener("click", () => closeSheetEl(reportDetailSheet, reportDetailBackdrop));

// ==================================================================
// LEADERBOARD VIEW
// ==================================================================
let lbRange = "today";
document.querySelectorAll(".lb-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".lb-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    lbRange = btn.dataset.range;
    renderLeaderboard();
  });
});

let leaderboardData = null;
async function loadLeaderboard() {
  try {
    leaderboardData = await OpsApi.getLeaderboard();
    renderLeaderboard();
  } catch (err) {
    toast(err.message, true);
  }
}
function renderLeaderboard() {
  if (!leaderboardData) return;
  const rows = leaderboardData[lbRange] || [];
  document.getElementById("lb-goal-line").textContent =
    lbRange === "campaign" ? `Campaign total: ${leaderboardData.campaignTotal} of 2,000-2,500 dogs` : "Resets at midnight IST.";

  const list = document.getElementById("leaderboard-list");
  if (!rows.length) {
    list.innerHTML = `<p class="muted">No visits logged yet.</p>`;
    return;
  }
  list.innerHTML = `<div class="card">${rows
    .map(
      (r, i) => `
    <div class="leaderboard-row">
      <div class="rank ${i === 0 ? "gold" : ""}">${i + 1}</div>
      <div>
        <div class="name">${escapeHtml(r.teamName)}</div>
        <div class="sub">${r.sitesClosed} site(s) closed</div>
      </div>
      <div class="score">${r.dogsVaccinated}</div>
    </div>`
    )
    .join("")}</div>`;
}

// ==================================================================
// ADMIN VIEW
// ==================================================================
async function loadAdmin() {
  try {
    const stats = await OpsApi.adminStats();
    document.getElementById("admin-stats-card").innerHTML = `
      <div class="info-row"><span class="label">Registrations synced</span><span class="value">${stats.totalRegistrations}</span></div>
      <div class="info-row"><span class="label">Dogs vaccinated</span><span class="value">${stats.dogsVaccinated} / ${stats.goalMin}-${stats.goalMax}</span></div>
      <div class="info-row"><span class="label">Sites done</span><span class="value">${stats.sitesClosed}</span></div>
      <div class="info-row"><span class="label">Sites open</span><span class="value">${stats.sitesOpen}</span></div>
      <div class="info-row"><span class="label">Needs manual pin</span><span class="value">${stats.needsPin}</span></div>
    `;
  } catch (err) {
    toast(err.message, true);
  }
  loadNeedsPinList();
  loadTeamsList();
}

document.getElementById("sync-sheet-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const resultEl = document.getElementById("sync-result");
  resultEl.textContent = "Syncing…";
  try {
    const r = await OpsApi.adminSync();
    resultEl.textContent = `Synced: ${r.inserted} new, ${r.updated} updated (${r.total} total rows).`;
    loadAdmin();
  } catch (err) {
    resultEl.textContent = "Sync failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("sync-csv-btn").addEventListener("click", async () => {
  const csv = document.getElementById("csv-input").value;
  const resultEl = document.getElementById("sync-result");
  if (!csv.trim()) { resultEl.textContent = "Paste CSV text first."; return; }
  resultEl.textContent = "Importing…";
  try {
    const r = await OpsApi.adminSyncCsv(csv);
    resultEl.textContent = `Imported: ${r.inserted} new, ${r.updated} updated (${r.total} total rows).`;
    loadAdmin();
  } catch (err) {
    resultEl.textContent = "Import failed: " + err.message;
  }
});

document.getElementById("geocode-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const resultEl = document.getElementById("geocode-result");
  resultEl.textContent = "Running (about 1 address/second, this can take a while)…";
  try {
    const r = await OpsApi.adminGeocode();
    resultEl.textContent =
      `Attempted ${r.attempted}: ${r.ok} placed, ${r.needsPin} need a manual pin` +
      (r.failed ? `, ${r.failed} left pending (${r.lastError || "lookup service error"}).` : ".");
    loadAdmin();
    loadRegistrations();
  } catch (err) {
    resultEl.textContent = "Geocode batch failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

function renderNeedsPinCards(wrap, rows) {
  if (!wrap) return;
  if (!rows.length) {
    wrap.innerHTML = `<p class="muted">Nothing waiting on a manual pin.</p>`;
    return;
  }
  wrap.innerHTML = rows
    .map(
      (r) => `
      <div class="card" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
        <div>
          <div style="font-weight:700; font-size:13px;">${escapeHtml(r.full_name || "Unnamed")}</div>
          <div class="muted" style="font-size:12px;">${escapeHtml(r.address || "")}${r.pin_code ? " · " + escapeHtml(r.pin_code) : ""}</div>
        </div>
        <button class="btn btn-outline drop-pin-btn" data-id="${r.id}" style="white-space:nowrap;">Drop pin</button>
      </div>`
    )
    .join("");
  wrap.querySelectorAll(".drop-pin-btn").forEach((btn) => {
    btn.addEventListener("click", () =>
      openPinDropMap(Number(btn.dataset.id), rows.find((r) => r.id === Number(btn.dataset.id)))
    );
  });
}

async function loadNeedsPinList() {
  try {
    // Shared list: any signed-in team can place an unfound address.
    const rows = await OpsApi.listRegistrations({ geocodeStatus: "needs_pin" });
    renderNeedsPinCards(document.getElementById("needs-pin-list"), rows);
    renderNeedsPinCards(document.getElementById("team-needs-pin-list"), rows);
  } catch (err) {
    ["needs-pin-list", "team-needs-pin-list"].forEach((id) => {
      const wrap = document.getElementById(id);
      if (wrap) wrap.innerHTML = `<p class="muted">Couldn't load the queue.</p>`;
    });
  }
}

// ---------- Manual registration ----------
const manualRegSheet = document.getElementById("manual-reg-sheet");
const manualRegBackdrop = document.getElementById("manual-reg-backdrop");
let manualRegLocation = null;

function resetManualRegistrationForm() {
  [
    "manual-full-name",
    "manual-contact-number",
    "manual-whatsapp-number",
    "manual-address",
    "manual-pin-code",
    "manual-dog-count",
    "manual-dog-location",
    "manual-health-concerns",
  ].forEach((id) => {
    document.getElementById(id).value = "";
  });
  document.getElementById("manual-temperament").value = "";
  document.getElementById("manual-deworm-status").value = "";
  document.getElementById("manual-nine-in-one").value = "";
  document.getElementById("manual-reg-error").style.display = "none";
  document.getElementById("manual-location-status").textContent = "No location selected.";
  manualRegLocation = null;
}

document.getElementById("manual-add-btn").addEventListener("click", () => {
  resetManualRegistrationForm();
  openSheetEl(manualRegSheet, manualRegBackdrop);
});
document.getElementById("manual-reg-cancel").addEventListener("click", () => {
  closeSheetEl(manualRegSheet, manualRegBackdrop);
});
manualRegBackdrop.addEventListener("click", () => closeSheetEl(manualRegSheet, manualRegBackdrop));

document.getElementById("manual-location-btn").addEventListener("click", () => {
  const address = document.getElementById("manual-address").value.trim();
  openPinDropMap(null, { address }, async (latlng) => {
    manualRegLocation = latlng;
    document.getElementById("manual-location-status").textContent =
      `Selected: ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}`;
  });
});

document.getElementById("manual-reg-save").addEventListener("click", async (e) => {
  const errorEl = document.getElementById("manual-reg-error");
  errorEl.style.display = "none";

  const payload = {
    fullName: document.getElementById("manual-full-name").value.trim(),
    contactNumber: document.getElementById("manual-contact-number").value.trim(),
    whatsappNumber: document.getElementById("manual-whatsapp-number").value.trim(),
    address: document.getElementById("manual-address").value.trim(),
    pinCode: document.getElementById("manual-pin-code").value.trim(),
    dogCount: Number(document.getElementById("manual-dog-count").value),
    dogLocation: document.getElementById("manual-dog-location").value.trim(),
    temperament: document.getElementById("manual-temperament").value,
    dewormStatus: document.getElementById("manual-deworm-status").value,
    healthConcerns: document.getElementById("manual-health-concerns").value.trim(),
    nineInOne: document.getElementById("manual-nine-in-one").value,
    lat: manualRegLocation?.lat,
    lng: manualRegLocation?.lng,
  };

  if (!payload.fullName || !payload.address || !payload.dogCount || !manualRegLocation) {
    errorEl.textContent = "Enter full name, address, dog count, and choose a map location.";
    errorEl.style.display = "block";
    return;
  }

  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await OpsApi.adminCreateRegistration(payload);
    closeSheetEl(manualRegSheet, manualRegBackdrop);
    toast("Registration added.");
    loadAdmin();
    loadRegistrations();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = "block";
  } finally {
    btn.disabled = false;
  }
});

async function loadTeamsList() {
  const wrap = document.getElementById("teams-list");
  try {
    const teams = await OpsApi.listTeams();
    wrap.innerHTML = teams
      .map((t) => `<div class="info-row"><span class="label">${escapeHtml(t.name)}${t.is_admin ? " (admin)" : ""}</span></div>`)
      .join("");
  } catch (err) {
    wrap.innerHTML = "";
  }
}

document.getElementById("create-team-btn").addEventListener("click", async () => {
  const name = document.getElementById("new-team-name").value.trim();
  const pin = document.getElementById("new-team-pin").value.trim();
  if (!name || !pin) { toast("Enter a team name and PIN.", true); return; }
  try {
    await OpsApi.createTeam(name, pin);
    document.getElementById("new-team-name").value = "";
    document.getElementById("new-team-pin").value = "";
    toast(`Team "${name}" created.`);
    loadTeamsList();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Manual pin-drop mini map ----------
let pinMapInstance = null;
let pinDropMarker = null;
let pinDropLatLng = null;
let pinDropRegId = null;
let pinDropSaveHandler = null;
const pinmapSheet = document.getElementById("pinmap-sheet");
const pinmapBackdrop = document.getElementById("pinmap-backdrop");

function openPinDropMap(regId, reg, onSave = null) {
  pinDropRegId = regId;
  pinDropSaveHandler = onSave;
  pinDropLatLng = null;
  document.getElementById("pinmap-address").textContent = reg?.address || "";
  document.getElementById("pinmap-search").value = reg?.address || "";
  document.getElementById("pinmap-search-status").textContent =
    "Search to move the map, then tap the exact location.";
  document.getElementById("pinmap-search-results").innerHTML = "";
  document.getElementById("pinmap-save").disabled = true;

  // Correcting an existing pin: start zoomed on where it currently sits, and
  // show that spot faded so the admin can see what they are moving. New pins
  // (needs_pin queue) keep the original Bhopal-wide starting view.
  const hasPin = reg && reg.lat != null && reg.lng != null;
  const center = hasPin ? [reg.lat, reg.lng] : BHOPAL;
  const zoom = hasPin ? 16 : 13;

  openSheetEl(pinmapSheet, pinmapBackdrop);
  setTimeout(() => {
    if (!pinMapInstance) {
      pinMapInstance = L.map("pinmap").setView(center, zoom);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(pinMapInstance);
      pinMapInstance.on("click", (e) => {
        pinDropLatLng = e.latlng;
        if (pinDropMarker) pinMapInstance.removeLayer(pinDropMarker);
        // Use the app's built-in marker shape instead of Leaflet's external
        // PNG icon so the selected point is visible even if icon assets fail.
        pinDropMarker = L.marker(e.latlng, { icon: pinIcon("open") }).addTo(pinMapInstance);
        document.getElementById("pinmap-save").disabled = false;
      });
    } else {
      pinMapInstance.setView(center, zoom);
    }
    if (pinDropMarker) { pinMapInstance.removeLayer(pinDropMarker); pinDropMarker = null; }
    if (hasPin) {
      pinDropMarker = L.marker(center, { icon: pinIcon("open"), opacity: 0.45 }).addTo(pinMapInstance);
    }
    pinMapInstance.invalidateSize();
  }, 60);
}

async function searchPinMap() {
  const input = document.getElementById("pinmap-search");
  const statusEl = document.getElementById("pinmap-search-status");
  const resultsEl = document.getElementById("pinmap-search-results");
  const q = input.value.trim();
  if (q.length < 3) {
    statusEl.textContent = "Enter at least 3 characters.";
    return;
  }

  statusEl.textContent = "Searching…";
  resultsEl.innerHTML = "";
  try {
    const results = await OpsApi.locationSearch(q);
    if (!results.length) {
      statusEl.textContent = "No places found. Try a locality, landmark, or PIN code.";
      return;
    }
    statusEl.textContent = "Choose a result, then tap the exact point on the map.";
    resultsEl.innerHTML = results
      .map(
        (result, index) =>
          `<button class="location-result" data-index="${index}">${escapeHtml(result.displayName)}</button>`
      )
      .join("");
    resultsEl.querySelectorAll(".location-result").forEach((button) => {
      button.addEventListener("click", () => {
        const result = results[Number(button.dataset.index)];
        pinMapInstance.setView([result.lat, result.lng], 16);
        pinDropLatLng = null;
        if (pinDropMarker) {
          pinMapInstance.removeLayer(pinDropMarker);
          pinDropMarker = null;
        }
        document.getElementById("pinmap-save").disabled = true;
        statusEl.textContent = "Map moved. Tap the exact location to place the pin.";
        resultsEl.innerHTML = "";
      });
    });
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

document.getElementById("pinmap-search-btn").addEventListener("click", searchPinMap);
document.getElementById("pinmap-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchPinMap();
  }
});

document.getElementById("pinmap-cancel").addEventListener("click", () => closeSheetEl(pinmapSheet, pinmapBackdrop));
pinmapBackdrop.addEventListener("click", () => closeSheetEl(pinmapSheet, pinmapBackdrop));
document.getElementById("pinmap-save").addEventListener("click", async () => {
  if (!pinDropLatLng || (!pinDropRegId && !pinDropSaveHandler)) return;
  try {
    if (pinDropSaveHandler) {
      await pinDropSaveHandler(pinDropLatLng);
    } else {
      await OpsApi.patchRegistration(pinDropRegId, {
        lat: pinDropLatLng.lat,
        lng: pinDropLatLng.lng,
      });
    }
    closeSheetEl(pinmapSheet, pinmapBackdrop);
    if (pinDropRegId) {
      toast("Pin saved.");
      loadNeedsPinList();
      if (ME.isAdmin) loadAdmin();
      loadRegistrations();
    }
  } catch (err) {
    toast(err.message, true);
  }
});
