const EARTH_RADIUS = 6378137;
const STORAGE_KEY = "bronymap-owned-markers-v1";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const API_BASE = LOCAL_HOSTS.has(window.location.hostname) ? "" : "https://api.bronymap.hachile.org";

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

let selectedLatLng = null;
let turnstileToken = null;
let turnstileWidgetId = null;

map.on("click", event => {
  selectedLatLng = event.latlng;
  drawSelection();
});

form.elements.precision.forEach(input => input.addEventListener("change", drawSelection));
form.addEventListener("submit", submitMarker);
document.querySelector("#privacy-button").addEventListener("click", () => privacyDialog.showModal());
document.querySelector("#privacy-close").addEventListener("click", () => privacyDialog.close());
privacyDialog.addEventListener("click", event => {
  if (event.target === privacyDialog) privacyDialog.close();
});

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
      setStatus("公开提交尚未配置完成，目前只能浏览地图。", "error");
      return;
    }
    if (config.turnstileSiteKey) loadTurnstile(config.turnstileSiteKey);
  } catch {
    submitButton.disabled = true;
    setStatus("无法读取站点配置。", "error");
  }
}

function loadTurnstile(siteKey) {
  window.onTurnstileReady = () => {
    turnstileWidgetId = window.turnstile.render("#turnstile-container", {
      sitekey: siteKey,
      theme: "light",
      size: "flexible",
      callback: token => { turnstileToken = token; },
      "expired-callback": () => { turnstileToken = null; }
    });
  };
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady&render=explicit";
  script.async = true;
  script.defer = true;
  document.head.append(script);
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
  selectionTitle.textContent = "已选择模糊区域";
  selectionDetail.textContent = `提交前会压缩到约 ${precisionKm} km 网格`;
}

async function submitMarker(event) {
  event.preventDefault();
  if (!selectedLatLng) {
    setStatus("请先在地图上点选一个大致位置。", "error");
    return;
  }

  const precisionKm = Number(form.elements.precision.value);
  const deleteToken = randomToken();
  const payload = {
    cell_id: toCellId(selectedLatLng.lat, selectedLatLng.lng, precisionKm),
    city_label: form.elements.city_label.value,
    display_name: form.elements.display_name.value,
    contact: form.elements.contact.value,
    delete_token: deleteToken,
    turnstile_token: turnstileToken
  };

  submitButton.disabled = true;
  setStatus("正在安全地添加标记……");
  try {
    const response = await fetch(`${API_BASE}/api/markers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "提交失败");

    saveOwnedMarker({ id: result.id, deleteToken, cityLabel: payload.city_label.trim() });
    form.reset();
    selectionLayer.clearLayers();
    selectedLatLng = null;
    selectionCard.dataset.selected = "false";
    selectionTitle.textContent = "还没有选择位置";
    selectionDetail.textContent = "点击地图任意位置开始";
    setStatus("标记已经点亮，90 天内有效。", "success");
    resetTurnstile();
    await loadMarkers();
    renderOwnedMarkers();
  } catch (error) {
    setStatus(error.message, "error");
    resetTurnstile();
  } finally {
    submitButton.disabled = false;
  }
}

async function loadMarkers() {
  try {
    const response = await fetch(`${API_BASE}/api/markers`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "地图加载失败");
    memberCount.textContent = new Intl.NumberFormat("zh-CN").format(data.total);
    renderMarkers(data.markers);
  } catch {
    memberCount.textContent = "0";
    setStatus("暂时无法读取地图数据。", "error");
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
    ? `${marker.city_label} · ${marker.count} 位小马迷`
    : marker.display_name || "一位小马迷";
  root.append(title);

  const meta = document.createElement("div");
  meta.className = "popup-meta";
  meta.textContent = `${marker.city_label} · 位置已模糊至约 ${marker.precision_km} km`;
  root.append(meta);

  if (marker.kind === "member" && marker.contact) {
    const contact = document.createElement("div");
    contact.className = "popup-contact";
    contact.textContent = marker.contact;
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
    empty.textContent = "此设备还没有保存删除密钥。";
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
    button.textContent = "删除";
    button.addEventListener("click", () => removeOwnedMarker(marker));
    row.append(label, button);
    myMarkerList.append(row);
  }
}

async function removeOwnedMarker(marker) {
  if (!window.confirm(`确定删除“${marker.cityLabel}”的标记吗？删除后无法恢复。`)) return;
  try {
    const response = await fetch(`${API_BASE}/api/markers/${encodeURIComponent(marker.id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delete_token: marker.deleteToken })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "删除失败");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getOwnedMarkers().filter(item => item.id !== marker.id)));
    renderOwnedMarkers();
    await loadMarkers();
    setStatus("标记已永久删除。", "success");
  } catch (error) {
    setStatus(error.message, "error");
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

function setStatus(message, tone = "") {
  formStatus.textContent = message;
  formStatus.dataset.tone = tone;
}
