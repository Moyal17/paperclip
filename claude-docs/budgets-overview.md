# Budgets & Burn Guards — Platform Overview

> Written 2026-06-21. How token/cost budgeting works in Paperclip: the two
> systems (user budgets + platform burn guards), the enforcement points, the
> incident/kill-switch lifecycle, and the practical "why did it pause my work
> and how do I clear it." Source of truth: `server/src/services/budgets.ts`,
> `server/src/services/heartbeat.ts`, `server/src/services/instance-settings.ts`,
> `doc/SPEC.md §6`, and the burn-guard docs (`platform-burn-guard-plan.md`,
> `per-run-ceiling-overview.md`).

---

## TL;DR

Two independent systems can pause an agent; both surface through the same
`budget_incidents` table, so they look alike:

1. **Budgets** — configurable per-scope caps (company / agent / project / issue)
   on a metric (`billed_cents` or `total_tokens`) over a window (`lifetime` or
   `calendar_month_utc`), with a soft warn threshold and a hard auto-pause.
2. **Burn guards** — platform-level safety rails (instance settings) that
   *auto-arm* system #1 and add per-run + anti-loop ceilings, so a runaway is
   caught even when nobody set a policy.

A hard-stop **pauses the scope and cancels in-flight work** (softened by the
grace band — see below). A paused scope blocks the next wake until an operator
raises the cap / resolves the incident.

---

## System A — Budgets (user-facing policies)

Table: `budget_policies`. One row per (scope, metric, window).

| Dimension | Values |
|---|---|
| **Scope** | `company` · `agent` · `project` · `issue`. An `issue` cap on a plan root also counts every descendant ticket (`plan_root_issue_id`). |
| **Metric** | `billed_cents` (dollars ×100) · `total_tokens` (= `input + cached_input + output`) |
| **Window** | `lifetime` (never resets) · `calendar_month_utc` (resets on the 1st, UTC) |
| **Soft threshold** | `warn_percent` (default 80) — alert only |
| **Hard threshold** | `amount` — the cap |
| **Switches** | `notify_enabled` (soft alerts) · `hard_stop_enabled` (auto-pause) · `is_active` |

`amount = 0` or `is_active = false` ⇒ effectively unlimited (no ceiling).

### Two trip levels (`evaluateCostEvent`)

After every cost event, observed spend for each relevant policy is recomputed
(`computeObservedAmount`) and compared:

1. **Soft** — `observed ≥ amount × warn_percent%` and `notify_enabled`
   → opens a **soft** incident + emits a `budget.threshold` live event. **No
   pause.** A heads-up.
2. **Hard** — `observed ≥ amount` and `hard_stop_enabled`
   → resolves the soft incident, opens a **hard** incident (with a
   `budget_override_required` approval card), and **pauses + cancels** the scope.
   For an `issue` plan root it also sets `plan_details.state = 'stopped'`.

### Enforcement points

| Point | File | What |
|---|---|---|
| **Pre-run gate** | `budgets.ts` `getInvocationBlock` (called from `heartbeat.ts` wake paths) | Before any wake spends a token, checks company → agent → issue/plan → project. If observed ≥ cap (or scope is paused / plan stopped), the wake is **blocked**. This is the "every wake cancelled with budget pause" symptom. |
| **Post-cost** | `budgets.ts` `evaluateCostEvent` | After a cost event lands, fires the soft/hard logic above. |

### Hard-stop grace band (shipped 2026-06-20, `9ddfafd6` + `974396d9`)

The automatic (cost-event-driven) hard-stop no longer kills an in-flight run the
instant the cap is crossed. Within `[cap, cap × graceFactor)` it **pauses the
scope (blocks the next wake) but lets the current run finish at its natural
boundary**; past `cap × graceFactor` it does the full pause-and-cancel (runaway
ceiling).

- `graceFactor` default **1.25**; env `PAPERCLIP_BUDGET_HARDSTOP_GRACE_FACTOR`;
  clamped `>= 1.0` (1.0 = old behavior, cancel exactly at the cap). Invalid
  *explicit* override (0/neg/NaN) fails safe to 1.0.
- The agent pause survives run completion (`finalizeAgentStatus` bails on
  `paused`); a stopped plan blocks new subtree work but does not cancel running
  subtree runs.
- The **deliberate board policy-downsize path keeps full enforce** — grace is
  only for the automatic accrual path.

---

## System B — Burn guards (platform safety rails)

Config: `instanceSettings.guards` (jsonb), edited via `PATCH /api/instance/settings/guards`.
Master switch `enabled`. Defaults live in `packages/shared/src/types/instance.ts`
(`DEFAULT_GUARD_*`).

| Guard | Purpose | Default |
|---|---|---|
| **G1** | the `guards` config object + `enabled` flag | — |
| **G2** | auto-create default budget policies per company/agent so a row always exists (reuses System A) | company **40M** tok/mo · agent **8M** tok/mo · warn 80% |
| **G3** | per-run ceiling: `--max-turns` floor + **post-run** token kill | **120** turns · **1M** tokens/run |
| **G4** | anti-loop breaker: too many runs in a tight loop → `pause_reason="runaway"` | **15** runs/hr · **6** consecutive same-issue |
| **G5** | trust surface — incidents + tests proving each guard fires | — |

**G3 is post-run, not mid-flight.** The adapter runs the Claude CLI as a
subprocess with no streaming usage, so per-run token totals are only known after
the run returns (`heartbeat.ts` `updateRuntimeState`). A fat run is sunk cost;
G3 pauses the *next* run + opens a `per_run_ceiling` incident. (Same limit that
makes a true mid-flight kill — and a during-run repeated-error abort — a large
adapter-protocol project.)

---

## Incident lifecycle & the kill switch

```
observed crosses cap
  → budget_incidents row (status='open', threshold_type='hard')
  → approval card (type='budget_override_required', status='pending')
  → scope paused (pause_reason='budget'); plan root → plan_details.state='stopped'
  → all new wakes blocked by getInvocationBlock
```

### Clearing a budget pause — the ONLY working paths

| Situation | Path |
|---|---|
| **Company** budget pause | `GET /api/companies/:id/budgets/overview` → for each open incident: `POST /api/companies/:id/budget-incidents/:incidentId/resolve` with `{"action":"raise_budget_and_resume","amount":<above amountObserved>}`. Raises the cap + calls `resumeScopeFromBudget`. `amount` MUST exceed observed or it throws. |
| **Agent** pause **with** an open incident | same incident-resolve path (agent-scope incident). |
| **Agent** pause with **no** open incident (e.g. agent at 102% of cap, `paused=true`, no `status='open'` row) | `POST /api/agents/:id/resume` — clears the agent flag. May re-pause next run if still over cap. |
| Reset the whole pilot | `scripts/reset-pilot.sh <companyId>` — step 0 raises guard defaults, clears budget pauses (incident-resolve), optionally fresh plan. |

**Do NOT expect `POST /api/companies/:id/reactivate` to work for budget** — it
hard-refuses while `pause_reason='budget'` (returns `budget_blocked`); it only
clears `pause_reason='manual'`. Budget pauses must go through incident-resolve.

> Raising a policy's `amount` directly in the DB does **not** auto-resume a
> already-paused scope (only the API upsert/incident-resolve path runs
> `resumeScopeFromBudget`). Bump the cap *and* clear the pause.

---

## Why it keeps pausing pilot work (and the fix)

Three things stack on a dogfood pilot:

1. **Tiny caps vs real usage.** Measured 2026-06-21 across 85 cost events / 11
   agents / 2 companies:

   | Metric | avg | p50 | p90 | max |
   |---|---|---|---|---|
   | per-agent tokens | 8.2M | 6.8M | 17M | **19.8M** |
   | per-task (issue) tokens | 3.8M | 2.9M | 8.3M | 9.1M |
   | per-run (cost event) tokens | 1.07M | 0.64M | 2.9M | 5.75M |
   | company tokens (month) | — | — | — | Hive Pilot (HIVA)=**72.8M**, Hive=18.0M |

   Two companies exist: **Hive Pilot** (`18b55ef9`, issue prefix `HIVA-*`) and
   **Hive** (`f5fad0cb`). The **Hive** dogfood company ran agent caps of
   **1M/3M per month** and a company cap of **15M**
   — far below the ~8M-avg / ~20M-max reality, so they trip almost immediately.
   Note per-run avg (1.07M) already brushes the G3 1M/run ceiling.

2. **Cold `--resume` replays inflate spend** against a `lifetime` window that
   never resets.

3. **(Pre-3.1)** the cancel was mid-flow + opaque → the CTO couldn't assign
   children → the whole gate chain stalled, looking like a wiring bug.

**Sizing rule:** set a cap to **observed max + headroom**, never to the average
(half your agents already exceed the average → instant re-pause).

### Caps applied 2026-06-21

Guard platform defaults (`PATCH /instance/settings/guards`): agent **25M/mo**,
company **100M/mo**, warn 80%. Existing policy rows raised to match:

| Scope | New cap |
|---|---|
| agent · `calendar_month_utc` | 25M |
| agent · `lifetime` | 30M (those under it) |
| company · `calendar_month_utc` | 100M |
| issue · `lifetime` | 15M |

If a pilot still trips after this, prefer raising the cap (or switching the
agent window from `lifetime` to `calendar_month_utc` so it resets monthly) over
disabling `hard_stop_enabled` — keep the runaway protection.

---

## Quick reference — endpoints

- `GET  /api/companies/:id/budgets/overview` — policies + active incidents
- `POST /api/companies/:id/budget-incidents/:incidentId/resolve` — raise & resume
- `POST /api/agents/:id/resume` — clear an agent-only pause
- `PATCH /api/instance/settings/guards` — platform guard defaults (System B)
- `scripts/reset-pilot.sh <companyId>` — full pilot reset (clears pauses)
