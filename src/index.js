const ALLOWED_PRECISIONS = new Set([10, 25]);
const MAX_MARKERS = 5000;
const NINETY_DAYS = 90 * 24 * 60 * 60;
const EARTH_RADIUS = 6378137;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/config" && request.method === "GET") {
        const local = isDevelopment(env, url.hostname);
        return json({
          submissionsEnabled: local || Boolean(env.JITTER_SECRET && env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY),
          turnstileSiteKey: env.TURNSTILE_SITE_KEY || null
        });
      }

      if (url.pathname === "/api/markers" && request.method === "GET") {
        return await listMarkers(env);
      }

      if (url.pathname === "/api/markers" && request.method === "POST") {
        return await createMarker(request, env, url);
      }

      const deleteMatch = url.pathname.match(/^\/api\/markers\/([0-9a-f-]{36})$/i);
      if (deleteMatch && request.method === "DELETE") {
        return await deleteMarker(request, env, url, deleteMatch[1]);
      }

      if (url.pathname.startsWith("/api/")) {
        return json({ error: "接口不存在" }, 404);
      }

      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error("Bronymap request failed", error?.stack || error);
      return json({ error: "服务暂时不可用，请稍后重试" }, 500);
    }
  }
};

async function listMarkers(env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM markers WHERE expires_at <= ?1").bind(now).run();
  const { results = [] } = await env.DB.prepare(
    `SELECT id, cell_id, precision_km, public_lat, public_lng, city_label,
            display_name, contact, created_at, expires_at
       FROM markers
      WHERE status = 'active' AND expires_at > ?1
      ORDER BY created_at DESC
      LIMIT ?2`
  ).bind(now, MAX_MARKERS).all();

  const cells = new Map();
  for (const marker of results) {
    const group = cells.get(marker.cell_id) || [];
    group.push(marker);
    cells.set(marker.cell_id, group);
  }

  const publicMarkers = [];
  for (const [cellId, group] of cells) {
    if (group.length < 3) {
      const center = cellCenter(cellId);
      publicMarkers.push({
        kind: "area",
        lat: center.lat,
        lng: center.lng,
        precision_km: group[0].precision_km,
        city_label: group[0].city_label,
        count: group.length
      });
      continue;
    }

    for (const marker of group) {
      publicMarkers.push({
        kind: "member",
        id: marker.id,
        lat: marker.public_lat,
        lng: marker.public_lng,
        precision_km: marker.precision_km,
        city_label: marker.city_label,
        display_name: marker.display_name,
        contact: marker.contact,
        expires_at: marker.expires_at
      });
    }
  }

  return json({ markers: publicMarkers, total: results.length });
}

async function createMarker(request, env, url) {
  if (!sameOrigin(request, url)) return json({ error: "来源不受信任" }, 403);
  if (!isJson(request)) return json({ error: "请求格式必须是 JSON" }, 415);

  const local = isDevelopment(env, url.hostname);
  if (!local && (!env.JITTER_SECRET || !env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY)) {
    return json({ error: "站点尚未完成安全配置，暂时不能提交" }, 503);
  }

  const body = await readSmallJson(request);
  const cell = parseCellId(body.cell_id);
  const cityLabel = cleanText(body.city_label, 60, true);
  const displayName = cleanText(body.display_name, 40, false) || null;
  const contact = cleanText(body.contact, 100, false) || null;
  const deleteToken = typeof body.delete_token === "string" ? body.delete_token : "";

  if (!cell) return json({ error: "位置网格无效" }, 400);
  if (deleteToken.length < 32 || deleteToken.length > 100) {
    return json({ error: "删除密钥无效" }, 400);
  }
  if (!local && !(await verifyTurnstile(body.turnstile_token, request, env))) {
    return json({ error: "人机验证失败，请重试" }, 400);
  }

  const id = crypto.randomUUID();
  const point = await pointForCell(body.cell_id, id, env.JITTER_SECRET || "local-development-only");
  const deleteHash = await hashText(deleteToken);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + NINETY_DAYS;

  await env.DB.prepare(
    `INSERT INTO markers
       (id, cell_id, precision_km, public_lat, public_lng, city_label,
        display_name, contact, delete_hash, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?11)`
  ).bind(
    id,
    body.cell_id,
    cell.precisionKm,
    point.lat,
    point.lng,
    cityLabel,
    displayName,
    contact,
    deleteHash,
    now,
    expiresAt
  ).run();

  return json({ id, expires_at: expiresAt }, 201);
}

async function deleteMarker(request, env, url, id) {
  if (!sameOrigin(request, url)) return json({ error: "来源不受信任" }, 403);
  if (!isJson(request)) return json({ error: "请求格式必须是 JSON" }, 415);

  const body = await readSmallJson(request);
  const deleteToken = typeof body.delete_token === "string" ? body.delete_token : "";
  if (deleteToken.length < 32 || deleteToken.length > 100) {
    return json({ error: "删除密钥无效" }, 400);
  }

  const deleteHash = await hashText(deleteToken);
  const result = await env.DB.prepare(
    "DELETE FROM markers WHERE id = ?1 AND delete_hash = ?2"
  ).bind(id, deleteHash).run();

  if (!result.meta?.changes) return json({ error: "没有找到标记或删除密钥错误" }, 404);
  return json({ ok: true });
}

async function verifyTurnstile(token, request, env) {
  if (!token || typeof token !== "string") return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET);
  form.set("response", token);
  const remoteIp = request.headers.get("CF-Connecting-IP");
  if (remoteIp) form.set("remoteip", remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });
  if (!response.ok) return false;
  const result = await response.json();
  return result.success === true;
}

async function readSmallJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4096) throw new HttpError("请求内容过大", 413);
  const text = await request.text();
  if (text.length > 4096) throw new HttpError("请求内容过大", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError("JSON 格式错误", 400);
  }
}

export function parseCellId(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(10|25):(-?\d+):(-?\d+)$/);
  if (!match) return null;
  const precisionKm = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!ALLOWED_PRECISIONS.has(precisionKm) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
  if (`${precisionKm}:${x}:${y}` !== value) return null;

  const size = precisionKm * 1000;
  const worldHalf = Math.PI * EARTH_RADIUS;
  if (Math.abs((x + 0.5) * size) > worldHalf || Math.abs((y + 0.5) * size) > worldHalf) return null;
  return { precisionKm, x, y, size };
}

export function cellCenter(cellId) {
  const cell = parseCellId(cellId);
  if (!cell) throw new Error("Invalid cell id");
  return mercatorToLatLng((cell.x + 0.5) * cell.size, (cell.y + 0.5) * cell.size);
}

export async function pointForCell(cellId, markerId, secret) {
  const cell = parseCellId(cellId);
  if (!cell) throw new Error("Invalid cell id");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${markerId}:${cellId}`)
  ));
  const view = new DataView(signature.buffer);
  const ratioX = view.getUint32(0) / 0xffffffff;
  const ratioY = view.getUint32(4) / 0xffffffff;
  const x = (cell.x + 0.15 + ratioX * 0.7) * cell.size;
  const y = (cell.y + 0.15 + ratioY * 0.7) * cell.size;
  return mercatorToLatLng(x, y);
}

function mercatorToLatLng(x, y) {
  const worldHalf = Math.PI * EARTH_RADIUS;
  const safeX = Math.max(-worldHalf, Math.min(worldHalf, x));
  const safeY = Math.max(-worldHalf, Math.min(worldHalf, y));
  return {
    lng: safeX / EARTH_RADIUS * 180 / Math.PI,
    lat: (2 * Math.atan(Math.exp(safeY / EARTH_RADIUS)) - Math.PI / 2) * 180 / Math.PI
  };
}

export async function hashText(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function cleanText(value, maxLength, required) {
  const cleaned = typeof value === "string"
    ? value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (required && !cleaned) throw new HttpError("请填写城市或地区", 400);
  if (cleaned.length > maxLength) throw new HttpError(`文字不能超过 ${maxLength} 个字符`, 400);
  return cleaned;
}

function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  return !origin || origin === url.origin;
}

function isJson(request) {
  return request.headers.get("content-type")?.toLowerCase().startsWith("application/json");
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isDevelopment(env, hostname) {
  return env.ALLOW_INSECURE_LOCAL === "true" || isLocalHostname(hostname);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...JSON_HEADERS,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "geolocation=(), camera=(), microphone=()");
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", "default-src 'self'; script-src 'self' https://unpkg.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
