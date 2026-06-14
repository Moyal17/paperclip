# Platform-Wide Agent Burn Guard — Global Runaway Protection

> Deliverable: on approval, this plan is saved to `claude-docs/platform-burn-guard-plan.md`.
> Build via `/dev-roles full` (touches server core — architect plan gate required).

## Context

B1 pilot: a **5-line changelog edit burned ~2.1M tokens** (the CTO looped 5× instead of
handing off once) and the window saw **~11M more tokens** from CMO/CEO exec agents
auto-waking 24× during un-paused setup. Billed $ = $0 (subscription-included), but the
token burn is real and would recur.

Root finding from codebase map: the platform has **good guard machinery but no default
arming of it**, and **no anti-loop breaker at all**.

| Guard | State today | Gap |
|---|---|---|
| `getInvocationBlock` pre-run gate (`budgets.ts:817`, called `heartbeat.ts:9909`) | checks company+agent scope automatically | only enforces if a policy **row exists** — none auto-created |
| `evaluateCostEvent` post-cost pause+incident+cancel (`budgets.ts:699`) | solid, battle-tested | same — needs a policy row to fire |
| `maxTurnsPerRun` | default **1000**, per-agent (`company-portability.ts:695`) | no platform floor; 1000 = effectively unbounded |
| per-run token ceiling | **none** | a single pathological run is uncapped |
| anti-loop / cooldown breaker | **none** (`cooldownSec:10` defined but unused) | nothing stopped 5×/24× repeated wakes |
| `instanceSettings` singleton (`general`/`experimental` jsonb) | exists | no platform-defaults section |

**Decisions (locked):** hard-stop posture · **tokens** as the cap metric (dollar caps never
fire on subscription runs) · build the anti-loop breaker now.

**Outcome:** every agent in every company — dev or exec, existing or new — is bounded by
(1) a token budget that auto-pauses + raises an incident, (2) a per-run hard ceiling, and
(3) a wake-rate breaker that trips on tight loops. Defense in depth, all reusing the
existing pause/incident/cancel path, all visible and tunable in one settings surface.

---

## Design — three layers + config + trust

### G1 — Platform guard config (foundation)
Home the defaults in the existing singleton, not a new table.

- Extend `instanceSettings` with a `guards` jsonb section (sibling of `general`/`experimental`).
  - `packages/db/src/schema/instance_settings.ts` — add `guards` column (jsonb, default `{}`), migration.
  - `server/src/services/instance-settings.ts` — `getGuards()` / `setGuards()` with normalized defaults (mirror existing `getGeneral`/`getExperimental` pattern, `:83-139`).
- Shape + recommended defaults (all tunable):
  ```jsonc
  {
    "enabled": true,
    "budget": {
      "metric": "total_tokens",
      "windowKind": "calendar_month_utc",
      "companyMonthlyTokens": 40000000,   // company-scope cap
      "agentMonthlyTokens":   8000000,    // per-agent cap
      "warnPercent": 80,
      "hardStop": true
    },
    "perRun": {
      "maxTurnsPerRun": 120,              // platform floor (down from 1000)
      "maxTokensPerRun": 1000000          // single-run kill ceiling
    },
    "breaker": {
      "maxRunsPerAgentPerHour": 15,
      "maxConsecutiveSameIssueRuns": 6    // with no stage/status progress
    }
  }
  ```
- Shared validator `guardsConfigSchema` in `packages/shared/src/validators` + types.

### G2 — Default budget policies, auto-armed + backfilled (the token ceiling)
Reuse the existing budget engine — just guarantee a policy row exists for every scope.

- **On company create** (`routes/companies.ts:303-339` / `services/companies.ts:262-271`):
  after insert, if `guards.enabled`, upsert a **company-scope** `total_tokens` policy from
  `guards.budget` (reuse `budgets.upsertPolicy`, already called there for `budgetMonthlyCents`).
- **On agent create** (`routes/agents.ts:2248-2366`): upsert an **agent-scope** token policy
  from `guards.budget.agentMonthlyTokens` (reuse the existing `:2352` budget-policy hook).
- **Backfill** existing companies + agents: idempotent script
  `server/scripts/backfill-guard-policies.ts` (or a one-shot service fn) that upserts the
  default policy anywhere one is absent. Run once; safe to re-run (upsert keyed by
  `companyId+scopeType+scopeId+metric+windowKind`).
- No change to enforcement — `getInvocationBlock` + `evaluateCostEvent` already do the work
  the moment a row exists. This alone closes the cross-agent $/token hole.

### G3 — Per-run hard ceiling (turns + tokens)
- **maxTurns floor:** resolve effective `maxTurnsPerRun = min(agent.adapterConfig value || ∞,
  guards.perRun.maxTurnsPerRun)` where the adapter config is built for a run
  (the spot feeding `claude-local/execute.ts:378`). Board can still raise per-agent above the
  floor by explicit override; default agents (and the 1000-template) get clamped to 120.
- **Per-run token kill:** in the per-run cost callback (`heartbeat.ts:7530`, `costs.createEvent`),
  accumulate this run's tokens; when cumulative > `guards.perRun.maxTokensPerRun`, cancel the
  run (reuse the run-cancel path used by budget hard-stop, `heartbeat.cancelBudgetScopeWork` /
  run abort) and open a `per_run_ceiling` incident. Catches a single pathological run the
  windowed budget would only catch after many runs.

### G4 — Anti-loop circuit breaker (the actual pilot failure)
New, small, enforced at the existing pre-run gate.

- New service `server/src/services/run-breaker.ts` — pure-ish evaluator:
  - `maxRunsPerAgentPerHour`: count `heartbeatRuns` for the agent in a rolling 1h window.
  - `maxConsecutiveSameIssueRuns`: count consecutive runs on the same issue with **no
    stage/status change** between them (compare issue stage at run boundaries).
- **Enforce in `enqueueWakeup`** (`heartbeat.ts:9792`), beside the budget block at `:9909`:
  if a threshold is exceeded → `writeSkippedRequest("breaker.tripped", …)` + pause the agent
  (`pauseReason:"runaway"`, reuse the budget pause path) + open a `runaway` incident.
- Resume path mirrors budget incidents: operator reviews the incident, resumes the agent.
- Tripping data (counts, window, issue) recorded on the incident so you see *why* it tripped.

### G5 — Trust surface + incidents + tests
Trust = you can see it, and tests prove each guard fires.

- **Settings UI**: a "Guardrails" panel reading/writing `instanceSettings.guards`
  (budget caps, per-run ceilings, breaker thresholds, master `enabled`). Mirror the existing
  experimental-flags settings component.
- **Incidents**: route `per_run_ceiling` + `runaway` through the existing `budget_incidents`
  surface (extend incident `kind`/`thresholdType`) so all auto-pauses appear in one place
  with resume/raise controls already built.
- **Tests (the trust contract)** — embedded-pg + unit, each asserts a guard actually trips:
  1. new company/agent → default token policies exist (G2).
  2. backfill → existing exec agent (CMO) gains a policy idempotently (G2).
  3. agent with `maxTurnsPerRun:1000` → effective run cap = 120 (G3).
  4. run exceeding `maxTokensPerRun` → run cancelled + incident (G3).
  5. simulate >15 runs/agent/hr → breaker trips, agent paused, incident raised (G4).
  6. simulate 6 consecutive no-progress same-issue runs → breaker trips (G4).
  7. cap reached → `getInvocationBlock` blocks next wake; raise-and-resume clears it (G2/G5).
  8. `guards.enabled=false` → zero new policies, no breaker (kill-switch for the guard itself).

---

## Files (primary)

| Area | File | Change |
|---|---|---|
| schema | `packages/db/src/schema/instance_settings.ts` + migration | add `guards` jsonb |
| config svc | `server/src/services/instance-settings.ts` | `getGuards()/setGuards()` + defaults |
| validator | `packages/shared/src/validators/*` + types | `guardsConfigSchema` |
| budget defaults | `server/src/routes/companies.ts`, `server/src/routes/agents.ts` | auto-upsert token policy on create |
| backfill | `server/scripts/backfill-guard-policies.ts` (new) | idempotent policy backfill |
| per-run ceiling | `server/src/services/heartbeat.ts` (run cost cb ~7530; adapter-config build) | maxTurns clamp + per-run token kill |
| breaker | `server/src/services/run-breaker.ts` (new) + `heartbeat.ts:9792` enqueueWakeup | wake-rate + same-issue breaker |
| incidents | `packages/db/src/schema/budget_incidents.ts` + `budgets.ts` | `per_run_ceiling`/`runaway` kinds |
| UI | `ui/src/components/settings/*` | Guardrails panel |
| tests | `server/src/__tests__/guard-*.test.ts` (new) | 8 trip-proof tests |

Reuse (do not rebuild): `budgets.upsertPolicy` (`budgets.ts:558`), `getInvocationBlock`
(`:817`), `evaluateCostEvent` (`:699`), pause+incident+cancel path, `writeSkippedRequest`,
`instanceSettingsService` pattern.

## Build order
G1 → G2 (+ backfill, arm the cross-agent ceiling first) → G3 → G4 → G5. Each through the
`/dev-roles` gates (architect plan approval, then code-review + wiring before DONE).

## Verification (end-to-end)
1. `pnpm -r typecheck` + new vitest green; existing budget/heartbeat suites green (no regression).
2. Live: `GET instanceSettings.guards` shows defaults; create a throwaway company → confirm
   company+agent token policies auto-created; run backfill → CMO/CEO gain agent policies.
3. Live runaway sim: temp-set `maxRunsPerAgentPerHour:2`, wake an agent 3× → 3rd wake skipped,
   agent paused `runaway`, incident visible; resume from the incident.
4. Live cap sim: temp-set `agentMonthlyTokens` below current spend → next wake blocked by
   `getInvocationBlock`; raise-and-resume clears it.
5. Confirm `guards.enabled=false` fully disarms (escape hatch).

## Recommendations baked in
- **Token metric, not dollars** — subscription runs bill $0; only token caps bite.
- **Hard-stop + incident**, not warn-only — matches "I don't want this again"; incident gives
  you the approve-to-resume control so a cap never silently strands real work.
- **Backfill is mandatory**, not just new-entity defaults — the agents that burned (CMO/CEO)
  already exist; new-only defaults would leave them unguarded.
- **Per-run kill + windowed budget are complementary** — the breaker stops loops fast, the
  per-run ceiling stops one fat run, the monthly budget stops slow bleed. No single layer is
  load-bearing.
- **`guards.enabled` master switch** — one flag to disarm everything if a guard ever
  misfires, so the safety system can't itself become a liability.
