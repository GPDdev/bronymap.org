import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLanguage, translate } from "../public/i18n.js";

test("language strings switch and interpolate", () => {
  assert.equal(normalizeLanguage("anything"), "zh");
  assert.equal(translate("en", "languageSwitch"), "中文");
  assert.equal(translate("en", "markerMeta", { city: "Ponyville", km: 25 }), "Ponyville · Location blurred to about 25 km");
});
