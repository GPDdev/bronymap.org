import test from "node:test";
import assert from "node:assert/strict";
import { cellCenter, cleanText, hashText, isTrustedOrigin, parseCellId, pointForCell } from "../src/index.js";

test("location cells are validated and deterministic", async () => {
  assert.deepEqual(parseCellId("v2:10:100:200"), { version: 2, precisionKm: 10, x: 100, y: 200, size: 10000 });
  assert.deepEqual(parseCellId("10:100:200"), { version: 1, precisionKm: 10, x: 100, y: 200, size: 10000 });
  assert.equal(parseCellId("1:100:200"), null);
  assert.equal(parseCellId("v2:10:not-a-number:200"), null);
  assert.equal(parseCellId("v2:10:0100:200"), null);

  const center = cellCenter("25:0:0");
  assert.ok(center.lat > 0 && center.lng > 0);

  const first = await pointForCell("v2:10:100:200", "marker-a", "test-secret");
  const second = await pointForCell("v2:10:100:200", "marker-a", "test-secret");
  const different = await pointForCell("v2:10:100:200", "marker-b", "test-secret");
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
  assert.match(await hashText("delete-token"), /^[0-9a-f]{64}$/);
});

test("v2 grid keeps its ground width near 60 degrees latitude", () => {
  const earthRadius = 6378137;
  const row = Math.floor(earthRadius * Math.PI / 3 / 10000);
  const west = cellCenter(`v2:10:0:${row}`);
  const east = cellCenter(`v2:10:1:${row}`);
  const deltaLng = (east.lng - west.lng) * Math.PI / 180;
  const lat = west.lat * Math.PI / 180;
  const distance = 2 * earthRadius * Math.asin(Math.cos(lat) * Math.sin(Math.abs(deltaLng) / 2));
  assert.ok(distance > 9900 && distance < 10100, `expected about 10 km, got ${distance}`);
});

test("only the site origin may write through the public API", () => {
  const apiUrl = new URL("https://bronymap-api.hachile.org/api/markers");
  assert.equal(isTrustedOrigin(new Request(apiUrl, { headers: { origin: "https://bronymap.hachile.org" } }), apiUrl), true);
  assert.equal(isTrustedOrigin(new Request(apiUrl, { headers: { origin: "https://evil.example" } }), apiUrl), false);
});

test("public profile fields are required and normalized", () => {
  assert.equal(cleanText("  Rainbow\nFan  ", 40, "昵称"), "Rainbow Fan");
  assert.throws(() => cleanText("  ", 100, "联系方式"), /请填写联系方式/);
});
