import test from "node:test";
import assert from "node:assert/strict";
import { cellCenter, hashText, parseCellId, pointForCell } from "../src/index.js";

test("location cells are validated and deterministic", async () => {
  assert.deepEqual(parseCellId("10:100:200"), { precisionKm: 10, x: 100, y: 200, size: 10000 });
  assert.equal(parseCellId("1:100:200"), null);
  assert.equal(parseCellId("10:not-a-number:200"), null);
  assert.equal(parseCellId("10:0100:200"), null);

  const center = cellCenter("25:0:0");
  assert.ok(center.lat > 0 && center.lng > 0);

  const first = await pointForCell("10:100:200", "marker-a", "test-secret");
  const second = await pointForCell("10:100:200", "marker-a", "test-secret");
  const different = await pointForCell("10:100:200", "marker-b", "test-secret");
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
  assert.match(await hashText("delete-token"), /^[0-9a-f]{64}$/);
});
