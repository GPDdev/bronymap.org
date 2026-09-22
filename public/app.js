import { normalizeLanguage, translate } from "./i18n.js";

const EARTH_RADIUS = 6378137;
const STORAGE_KEY = "bronymap-owned-markers-v1";
const LANGUAGE_KEY = "bronymap-language";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const API_BASE = LOCAL_HOSTS.has(window.location.hostname) ? "" : "https://bronymap-api.hachile.org";

const map = L.map("map", { minZoom: 2, maxZoom: 11, zoomControl: false }).setView([28, 15], 3);
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 11,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const publicLayer = L.layerGroup().addTo(map);
const selectionLayer = L.layerGroup().addTo(map);
const form = document.querySelector("#marker-form");
const submitButton = document.querySelector("#submit-button");
const formStatus = document.querySelector("#form-status");
const selectionCard = document.querySelector("#selection-card");
const selectionTitle = document.querySelector("#selection-title");
const selectionDetail = document.querySelector("#selection-detail");
const memberCount = document.querySelector("#member-count");
const myMarkerList = document.querySelector("#my-marker-list");
const privacyDialog = document.querySelector("#privacy-dialog");
const languageButton = document.querySelector("#language-button");
const metaDescription = document.querySelector("#meta-description");

let selectedLatLng = null;
let turnstileToken = null;
let turnstileWidgetId = null;
let turnstileSiteKey = null;
let language = normalizeLanguage(localStorage.getItem(LANGUAGE_KEY));
let visibleMarkers = [];
let markerTotal = 0;
let statusState = null;

map.on("click", event => {
  selectedLatLng = event.latlng;
  drawSelection();
});

form.elements.precision.forEach(input => input.addEventListener("change", drawSelection));
form.addEventListener("submit", submitMarker);
document.querySelector("#privacy-button").addEventListener("click", () => privacyDialog.showModal());
document.querySelector("#privacy-close").addEventListener("click", () => privacyDialog.close());
languageButton.addEventListener("click", () => applyLanguage(language === "zh" ? "en" : "zh"));
privacyDialog.addEventListener("click", event => {
  if (event.target === privacyDialog) privacyDialog.close();
});

applyLanguage(language);
void initialize();

async function initialize() {
  renderOwnedMarkers();
  await Promise.all([loadMarkers(), configureSubmissions()]);
}

async function configureSubmissions() {
  try {
    const response = await fetch(`${API_BASE}/api/config`, { cache: "no-store" });
    const config = await response.json();
    if (!config.submissionsEnabled) {
      submitButton.disabled = true;
      setStatus("submissionsDisabled", "error");
      return;
    }
    if (config.turnstileSiteKey) loadTurnstile(config.turnstileSiteKey);
  } catch {
    submitButton.disabled = true;
    setStatus("configFailed", "error");
  }
}

function loadTurnstile(siteKey) {
  turnstileSiteKey = siteKey;
  window.onTurnstileReady = renderTurnstile;
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady&render=explicit";
  script.async = true;
  script.defer = true;
  document.head.append(script);
}

function renderTurnstile() {
  turnstileToken = null;
  if (turnstileWidgetId !== null) window.turnstile.remove(turnstileWidgetId);
  turnstileWidgetId = window.turnstile.render("#turnstile-container", {
    sitekey: turnstileSiteKey,
    theme: "light",
    size: "flexible",
    language: language === "en" ? "en" : "zh-CN",
    callback: token => { turnstileToken = token; },
    "expired-callback": () => { turnstileToken = null; }
  });
}

function drawSelection() {
  if (!selectedLatLng) return;
  const precisionKm = Number(form.elements.precision.value);
  const cellId = toCellId(selectedLatLng.lat, selectedLatLng.lng, precisionKm);
  const center = cellCenter(cellId);

  selectionLayer.clearLayers();
  L.circle(center, {
    radius: precisionKm * 700,
    color: "#7457c8",
    weight: 2,
    opacity: 0.75,
    fillColor: "#ef6c9e",
    fillOpacity: 0.12,
    interactive: false
  }).addTo(selectionLayer);
  L.circleMarker(center, {
    radius: 6,
    color: "#fff",
    weight: 3,
    fillColor: "#7457c8",
    fillOpacity: 1,
    interactive: false
  }).addTo(selectionLayer);

  selectionCard.dataset.selected = "true";
  selectionTitle.textContent = t("selectionSelectedTitle");
  selectionDetail.textContent = t("selectionSelectedDetail", { km: precisionKm });
}

async function submitMarker(event) {
  event.preventDefault();
  if (!selectedLatLng) {
    setStatus("chooseLocation", "error");
    return;
  }

  const precisionKm = Number(form.elements.precision.value);
  const deleteToken = randomToken();
  const payload = {
    cell_id: toCellId(selectedLatLng.lat, selectedLatLng.lng, precisionKm),
    city_label: form.elements.city_label.value,
    display_name: form.elements.display_name.value,
    contact: form.elements.contact.value,
    profile_public: form.elements.consent.checked,
    delete_token: deleteToken,
    turnstile_token: turnstileToken
  };

  submitButton.disabled = true;
  setStatus("submitting");
  try {
    const response = await fetch(`${API_BASE}/api/markers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(localizeApiError(result.error, "submitFailed"));

    saveOwnedMarker({ id: result.id, deleteToken, cityLabel: payload.city_label.trim() });
    form.reset();
    selectionLayer.clearLayers();
    selectedLatLng = null;
    selectionCard.dataset.selected = "false";
    selectionTitle.textContent = t("selectionNoneTitle");
    selectionDetail.textContent = t("selectionNoneDetail");
    setStatus("submitted", "success");
    resetTurnstile();
    await loadMarkers();
    renderOwnedMarkers();
  } catch (error) {
    setRawStatus(error.message, "error");
    resetTurnstile();
  } finally {
    submitButton.disabled = false;
  }
}

async function loadMarkers() {
  try {
    const response = await fetch(`${API_BASE}/api/markers`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(localizeApiError(data.error, "mapLoadFailed"));
    markerTotal = data.total;
    visibleMarkers = data.markers;
    renderMemberCount();
    renderMarkers(visibleMarkers);
  } catch {
    markerTotal = 0;
    renderMemberCount();
    setStatus("mapFailed", "error");
  }
}

function renderMarkers(markers) {
  publicLayer.clearLayers();
  for (const marker of markers) {
    const isArea = marker.kind === "area";
    const icon = L.divIcon({
      className: "",
      html: isArea ? `<span class="area-pin">${marker.count}</span>` : '<span class="pony-pin">🐴</span>',
      iconSize: isArea ? [38, 38] : [34, 34],
      iconAnchor: isArea ? [19, 19] : [17, 17]
    });
    const pin = L.marker([marker.lat, marker.lng], { icon }).addTo(publicLayer);
    pin.bindPopup(makePopup(marker));
  }
}

function makePopup(marker) {
  const root = document.createElement("div");
  const title = document.createElement("p");
  title.className = "popup-title";
  title.textContent = marker.kind === "area"
    ? t("legacyTitle", { city: marker.city_label, count: marker.count })
    : marker.display_name || t("anonymousMember");
  root.append(title);

  const meta = document.createElement("div");
  meta.className = "popup-meta";
  meta.textContent = t("markerMeta", { city: marker.city_label, km: marker.precision_km });
  root.append(meta);

  if (marker.kind === "member" && marker.contact) {
    const contact = document.createElement("div");
    contact.className = "popup-contact";
    contact.textContent = t("contactValue", { contact: marker.contact });
    root.append(contact);
  }
  return root;
}

function renderOwnedMarkers() {
  const markers = getOwnedMarkers();
  myMarkerList.replaceChildren();
  if (!markers.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("noDeleteKeys");
    myMarkerList.append(empty);
    return;
  }

  for (const marker of markers) {
    const row = document.createElement("div");
    row.className = "owned-marker";
    const label = document.createElement("span");
    label.textContent = marker.cityLabel;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t("delete");
    button.addEventListener("click", () => removeOwnedMarker(marker));
    row.append(label, button);
    myMarkerList.append(row);
  }
}

async function removeOwnedMarker(marker) {
  if (!window.confirm(t("deleteConfirm", { city: marker.cityLabel }))) return;
  try {
    const response = await fetch(`${API_BASE}/api/markers/${encodeURIComponent(marker.id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete_token: marker.deleteToken })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(localizeApiError(result.error, "deleteFailed"));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getOwnedMarkers().filter(item => item.id !== marker.id)));
    renderOwnedMarkers();
    await loadMarkers();
    setStatus("deleted", "success");
  } catch (error) {
    setRawStatus(error.message, "error");
  }
}

function saveOwnedMarker(marker) {
  const markers = getOwnedMarkers().filter(item => item.id !== marker.id);
  markers.push(marker);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(markers));
}

function getOwnedMarkers() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function toCellId(lat, lng, precisionKm) {
  const safeLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = EARTH_RADIUS * lng * Math.PI / 180;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + safeLat * Math.PI / 360));
  const size = precisionKm * 1000;
  return `${precisionKm}:${Math.floor(x / size)}:${Math.floor(y / size)}`;
}

function cellCenter(cellId) {
  const [precisionKm, cellX, cellY] = cellId.split(":").map(Number);
  const size = precisionKm * 1000;
  const x = (cellX + 0.5) * size;
  const y = (cellY + 0.5) * size;
  return {
    lng: x / EARTH_RADIUS * 180 / Math.PI,
    lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI
  };
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function resetTurnstile() {
  turnstileToken = null;
  if (turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
}

function t(key, values) {
  return translate(language, key, values);
}

function applyLanguage(nextLanguage) {
  language = normalizeLanguage(nextLanguage);
  localStorage.setItem(LANGUAGE_KEY, language);
  document.documentElement.lang = language === "en" ? "en" : "zh-CN";
  document.title = t("documentTitle");
  metaDescription.content = t("description");
  document.querySelectorAll("[data-i18n]").forEach(element => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(element => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria]").forEach(element => { element.setAttribute("aria-label", t(element.dataset.i18nAria)); });
  languageButton.textContent = t("languageSwitch");
  languageButton.setAttribute("aria-label", t("languageSwitch"));
  if (selectedLatLng) drawSelection();
  else {
    selectionTitle.textContent = t("selectionNoneTitle");
    selectionDetail.textContent = t("selectionNoneDetail");
  }
  renderMemberCount();
  renderMarkers(visibleMarkers);
  renderOwnedMarkers();
  renderStatus();
  if (turnstileSiteKey && window.turnstile) renderTurnstile();
}

function renderMemberCount() {
  memberCount.textContent = new Intl.NumberFormat(language === "en" ? "en" : "zh-CN").format(markerTotal);
}

function setStatus(key, tone = "", values = {}) {
  statusState = { key, tone, values };
  renderStatus();
}

function setRawStatus(message, tone = "") {
  statusState = { message, tone };
  renderStatus();
}

function renderStatus() {
  formStatus.textContent = statusState?.key ? t(statusState.key, statusState.values) : statusState?.message || "";
  formStatus.dataset.tone = statusState?.tone || "";
}

function localizeApiError(message, fallbackKey) {
  const key = {
    "来源不受信任": "apiUntrusted",
    "接口不存在": "apiMissing",
    "服务暂时不可用，请稍后重试": "apiUnavailable",
    "请求格式必须是 JSON": "apiJsonOnly",
    "站点尚未完成安全配置，暂时不能提交": "apiNotReady",
    "位置网格无效": "apiInvalidGrid",
    "请确认公开信息授权": "apiConsent",
    "删除密钥无效": "apiInvalidDeleteKey",
    "人机验证失败，请重试": "apiChallenge",
    "没有找到标记或删除密钥错误": "apiMarkerMissing",
    "请填写城市或地区": "apiCityRequired",
    "请填写昵称": "apiNicknameRequired",
    "请填写联系方式": "apiContactRequired"
  }[message];
  return key ? t(key) : language === "en" ? t(fallbackKey) : message || t(fallbackKey);
}
