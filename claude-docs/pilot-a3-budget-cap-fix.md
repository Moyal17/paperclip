# Pilot A3 — Right-Size Budget Caps + Reset-Pilot Floor

**Branch:** `pilot/b1-dogfood`
**Commit:** `317035bc`
**Scope:** `scripts/reset-pilot.sh` only

---

## Background

HIVA-17 benchmark run exposed two related budget-guard failures that killed every pilot chain mid-run:

1. **Per-agent monthly cap too tight.** The pilot instance had `agentMonthlyTokens` set to 500k. One real review pass (Code Reviewer: 1.22M tokens, Wiring Expert: 0.97M tokens) blew through that in a single run. Both reviewers and the CTO hit the hard-stop, paused the company, and needed manual incident recovery before the chain could continue.

2. **Incident-resolve formula overcorrected.** `reset-pilot.sh` resolved open budget incidents by raising the cap to `Math.max(observed * 4, observed + 100_000_000, 100_000_000)` — always ≥ 100M. This effectively disabled the kill-switch: a genuine runaway (cold-resume replay loop, which burned 4.75M per CTO wake × 8 replays) would no longer trip the guard.

---

## What Changed

### `scripts/reset-pilot.sh`

**Change 1 — guard right-sizing (new step 0):**

Added a `PATCH /api/instance/settings/guards` call at the top of `reset-pilot.sh` that sets `agentMonthlyTokens: 5_000_000` before every pilot run.

```
reset-pilot.sh invoked
  → PATCH /api/instance/settings/guards { budget: { agentMonthlyTokens: 5000000 } }
  → instanceSettingsRoutes (instance-settings.ts:108)
  → instanceSettingsService.updateGuards()
  → normalizeGuardsConfig() validates + merges
  → DB write: instance_settings.guards.budget.agentMonthlyTokens = 5000000
  → res.json(updated.guards)    ← InstanceGuardsConfig shape (has `.budget`, not `.guards.budget`)
  → shell checks d.budget → "ok" or warning
```

**5M rationale:**
- One review pass: ~1.25M → 4× headroom within 5M monthly
- Full dev_team chain per agent: CTO warm session << 5M; each reviewer single pass << 5M
- Genuine runaway (cold-resume loop at 4.75M/replay): trips 5M cap → kill-switch still works

**Change 2 — incident-resolve floor:**

```js
// Before:
const next = Math.max(observed * 4, observed + 100000000, 100000000);
// → always ≥ 100M — silently disables the kill-switch

// After:
const next = Math.max(observed + 5000000, 5000000);
// → 5M above observed — headroom for rest of pilot, guard still active
```

Edge cases:
- `observed = 0`: `Math.max(5M, 5M) = 5M` ✓
- `observed = 1.2M` (reviewer): `1.2M + 5M = 6.2M` ✓
- `observed = 4.75M` (CTO cold-resume): `4.75M + 5M = 9.75M` ✓

---

## AC Verification

- Full `dev_team` chain completes without budget pause: monthly cap (5M) >> one review pass (~1.25M), so no mid-chain hard-stop.
- Genuine runaway (cold-resume loop): each CTO replay is ~4.75M → trips 5M cap on second replay. Kill-switch preserved.

---

## Files Changed

| File | Change |
|---|---|
| `scripts/reset-pilot.sh` | Add step 0: PATCH guards to set `agentMonthlyTokens = 5M`; fix incident-resolve floor from `+100M` to `+5M` |
