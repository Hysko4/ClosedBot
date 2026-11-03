import assert from "node:assert/strict";
import { test } from "node:test";
import { antigravityHasUsage, antigravityVersion } from "../src/providers/antigravity.js";
import { antigravityUsage, grokUsage } from "../src/providers/usage.js";

test("uso de Grok: crédito del período, plan legible y valores que faltan", () => {
  const week = { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-01T07:53:13.535+00:00", end: "2026-11-08T07:53:13.535+00:00" };
  assert.deepEqual(grokUsage({ config: { creditUsagePercent: 51, currentPeriod: week }, subscription_tier: "SUBSCRIPTION_TIER_SUPER_GROK_HEAVY" }), {
    available: true,
    plan: "SuperGrok Heavy",
    windows: [{ id: "credit", label: "Semanal", usedPercent: 51, resetsAt: "2026-11-08T07:53:13.535Z" }],
  });
  // Sin creditUsagePercent es 0 (su JSON omite los ceros); con límite y gasto, sale la proporción.
  assert.equal(grokUsage({ config: { currentPeriod: week } }).windows[0]?.usedPercent, 0);
  const monthly = grokUsage({
    config: { monthlyLimit: { val: 3000 }, used: { val: 750 }, billingPeriodStart: "2026-11-01T00:00:00Z", billingPeriodEnd: "2026-12-01T00:00:00Z" },
    subscription_tier: "SuperGrok",
  });
  assert.deepEqual([monthly.plan, monthly.windows[0]?.label, monthly.windows[0]?.usedPercent], ["SuperGrok", "Mensual", 25]);
  assert.equal(grokUsage({ config: {}, subscription_tier: "SUBSCRIPTION_TIER_UNSPECIFIED" }).plan, null);
  assert.equal(grokUsage({ config: {} }).windows[0]?.label, "Crédito");
  assert.deepEqual(grokUsage({}), { available: false, plan: null, windows: [] });
  assert.deepEqual(grokUsage(null), { available: false, plan: null, windows: [] });
});

test("uso de Gemini: «/usage» de Antigravity, solo los grupos de Gemini", () => {
  const text = [
    "### Quota Limits",
    "- **Gemini**",
    "  - **Daily Limit Remaining:** 12.5% remaining (resets Dec 1, 2026, 9:05 UTC)",
    "  - **Requests per minute:** 80% remaining",
    "- **Claude and GPT models**",
    "  - **Weekly Limit Remaining:** 10% remaining (resets Nov 08, 2026, 04:39 UTC)",
    "",
    "### Otra cosa",
    "- **Gemini Extra**",
    "  - **Weekly Limit Remaining:** 1% remaining",
  ].join("\r\n");
  assert.deepEqual(antigravityUsage(text), {
    available: true,
    plan: null,
    windows: [
      { id: "daily", label: "Diario", usedPercent: 87.5, resetsAt: "2026-12-01T09:05:00.000Z" },
      { id: "gemini:Requests per minute", label: "Requests per minute", usedPercent: 20, resetsAt: null },
    ],
  });
  for (const nothing of ["", "### Session Usage\n- **Session total:** data not available yet", "### Quota Limits\n- **Claude and GPT models**\n  - **Weekly Limit Remaining:** 10% remaining"]) {
    assert.deepEqual(antigravityUsage(nothing), { available: false, plan: null, windows: [] });
  }
});

test("Antigravity: versión de su carpeta y desde cuál contesta «/usage»", () => {
  assert.equal(antigravityVersion("C:\\Users\\a\\AppData\\Roaming\\OpenBot\\provider-runtimes\\antigravity\\1.4.5\\bin\\agy_acp_server.exe".replaceAll("\\", "/")), "1.4.5");
  assert.equal(antigravityVersion("/srv/programas/antigravity/1.4.1/agy_acp_server.par"), "1.4.1");
  assert.equal(antigravityVersion("/usr/bin/agy"), null);
  assert.deepEqual(
    ["1.4.0", "1.4.1", "1.4.5", "1.5.0", "2.0.0", "1.3.9", null].map(antigravityHasUsage),
    [false, true, true, true, true, false, false],
  );
});
