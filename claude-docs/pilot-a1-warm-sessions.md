# Pilot A1 — Warm Cached Agent Sessions (Kill Cold --resume Replay)

**Branch:** `pilot/b1-dogfood`
**Commit:** `a1234a82`
**Scope:** `server/src/services/heartbeat.ts`, `server/src/__tests__/session-rotation-decision.test.ts`

---

## Problem

In HIVA-17, the CTO agent consumed 4.75M tokens — 52% of total tracked spend. The cause:
each of its 8+ wakes cold-resumed a growing transcript. Anthropic's prompt cache has a 5-minute
TTL; any wake spaced >5 min from the previous run re-bills the entire accumulated transcript
at full price.

Gate review gaps (architect, code reviewer, wiring expert) are always >5min, so every
post-gate CTO wake was a cold resume. Concretely:
- Wake 1: 0 transcript (fresh)
- Wake 2: replays wake-1 at full price
- Wake 3: replays wake-1+2 at full price
- Wake N: replays all prior wakes at full price

A1a (already shipped) addressed ≥70% full sessions: rotate proactively before the cold
replay would push the session over the token threshold. But a 10-run CTO accumulates ~50k
tokens/run → only reaches 70% of a 600k threshold at run ~8. Wakes 2–7 still cold-replay.

---

## Prior art: A1a

`decideSessionRotation` already has:

```typescript
// A1a: session ≥70% full AND cache cold → rotate proactively
if (
  latestInputTokens >= policy.maxRawInputTokens * PROACTIVE_SESSION_FILL_RATIO &&
  latestRunCreatedAtMs != null &&
  nowMs - latestRunCreatedAtMs >= SESSION_CACHE_TTL_MS
) { return "...rotating proactively"; }
```

Gap: fires only when both conditions are true. Sub-70% cold sessions still replay.

---

## Fix: A1b

New branch in `decideSessionRotation`, placed after A1a and outside the
`maxRawInputTokens` guard:

```typescript
// A1b: any cold session rotates unconditionally.
if (
  latestRunCreatedAtMs != null &&
  nowMs - latestRunCreatedAtMs >= SESSION_CACHE_TTL_MS
) {
  const gapMin = Math.round((nowMs - latestRunCreatedAtMs) / 60_000);
  return `session cache cold (${gapMin}min gap) — rotating to avoid full transcript replay`;
}
```

**Key design decisions:**
- Outside `maxRawInputTokens > 0` guard: cold replay cost is real even when no token threshold is configured
- After A1a: ≥70% cold sessions keep the "near-threshold" message (more informative for ops)
- `latestRunCreatedAtMs != null` guard: no prior runs = no transcript to replay
- Message includes gap duration for diagnostics

---

## Effect

After A1b, inter-gate wakes (architect review, code review, wiring review) always
trigger rotation → fresh session with handoff summary. The CTO no longer replays its
full accumulated transcript on each post-gate wake.

Expected outcome (comparable future pilot):
- CTO wakes 2..N: each starts fresh, pays only for summary + new work (~10-50k tokens/wake)
- vs HIVA-17: 4.75M CTO tokens across 8+ wakes with full replay

---

## Tests

`server/src/__tests__/session-rotation-decision.test.ts` — 15 tests total, 5 new A1b cases:

| Test | Expect |
|---|---|
| Small cold session (10% fill) | A1b fires |
| Small hot session (10% fill, <5min) | null |
| ≥70% fill + cold | A1a fires (not A1b) — "proactively" in message |
| No prior run (`latestRunCreatedAtMs = null`) | null |
| Gap duration in message (30min gap) | message contains "30min" |

Plus 2 updated existing tests:
- `does NOT rotate under 70% even with cold cache` → A1b now fires → expectation updated
- `no token-based rotation when maxRawInputTokens is 0` → A1b fires for cold → expectation updated

All 15 pass.

---

## AC

- `decideSessionRotation` returns non-null for any cold session (latestRunCreatedAtMs set, >5min gap)
- Hot sessions (gap <5min) still return null and resume normally
- A1a message ("proactively") preserved for ≥70% cold sessions
- 15 session-rotation tests pass

---

## Files Changed

| File | Change |
|---|---|
| `server/src/services/heartbeat.ts` | A1b branch in `decideSessionRotation` (15 lines) |
| `server/src/__tests__/session-rotation-decision.test.ts` | 5 new A1b tests + 2 updated existing |
