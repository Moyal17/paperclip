# Gate-Triage Plan — right-size the dev-team for each task

> Rewritten 2026-06-14 after verifying the B1 pilot evidence against the code.
> The factory runs the **full 5-role gate** (Architect plan approval → Implementor
> → Code Reviewer → Wiring Expert → CTO close) for *every* task. The first real
> task — [HIV-12] "add one CHANGELOG.md line" — cost an estimated **~300–500k
> tokens** across 5–6 heartbeat runs (CTO burned 2.2M lifetime, Architect 1.17M
> doing nothing) to ship a one-line docs change.
>
> This plan adds a **triage gate**: the task is classified into a tier
> (`solo`/`light`/`full`) and only the needed agents are gated. **Correction vs
> the first draft:** the dev_team gate flow does NOT go through
> `executionPolicy.stages`; it builds approvals directly. Layer 2 is retargeted
> accordingly. A server-side hard-rule enforcer gives the safety floor structural
> teeth instead of trusting the model.

---

## Problem (one sentence)

The gate set is fixed at maximum for all tasks, so trivial and low-risk work pays
the full multi-agent orchestration cost with no quality benefit.

### Evidence (grounded)

- `PlanGateProfile = "none" | "dev_team"` — a hardcoded binary, no tier knob
  (`packages/shared/src/types/issue.ts:266`).
- `dev_team` activation **always** emits `1 plan-approval + (code-review +
  wiring) × every leaf` (`server/src/services/plan-gates.ts:65`
  `buildGateApprovalsForActivation`). Fixed-maximum by construction.
- HIV-12 ran the full gate on a one-line docs change; the plan even hand-wrote a
  "trivial docs change" routing line that the workflow ignored.

---

## Architecture correction (why the first draft would have missed)

There are **two independent gate systems** in Paperclip:

| System | Path | Used by |
|---|---|---|
| **Stage machine** | `executionPolicy.stages[]` + `applyIssueExecutionPolicyTransition` (`issue-execution-policy.ts:1050`) | per-issue execution policy, low-trust review presets |
| **Plan gate profile** | `dev_team` → `buildGateApprovalsForActivation` creates approval rows directly (`plan-gates.ts:65`) | the dev-team factory |

The dev_team factory **never reads `executionPolicy.stages`**. So the first
draft's Layer 2 — "have the CTO write `executionPolicy.stages` per tier" — would
have changed nothing for dev_team tasks. **Layer 2 must target the plan gate
profile path.**

---

## Proposal — three layers

### Layer 0 — Server-side hard-rule enforcer (NEW, ship first, structural)

The safety floor must not depend on model obedience. Add a pure function that
classifies a task's **maximum-allowed downgrade** from the touched-path set and
file count, computed at plan-create from the plan's declared scope:

```
forceFullIf(touchedPaths, fileCount):
  any path matches /auth|authz|login|session|token|secret|credential/  → full
  any path matches /migration|schema|\.sql$/                            → full
  any path matches /payment|billing|invoice|charge/                    → full
  any path under a public-API surface (routes/openapi)                 → full
  fileCount > N (start N = 5)                                          → full
  else → null (no floor; triage may downgrade)
```

- **Location:** new `server/src/services/gate-triage.ts`, pure + unit-tested.
- The CTO's tier *request* is an input; this function is the *ceiling*. Final tier
  = `max(requestedTier, forcedFloor)`. The platform can override the model
  upward, never the reverse. This is the structural teeth the first draft lacked.

### Layer 1 — Tier as a first-class plan field (replaces prompt-only triage)

Promote tier from prose to data. Two options, recommend **(a)**:

- **(a) Extend `PlanGateProfile`** → `"none" | "solo" | "light" | "dev_team"`
  (`types/issue.ts:266`). `dev_team` stays = `full` for back-compat; `solo`/`light`
  are the new right-sized profiles. Minimal blast radius — it's an enum + a switch.
- (b) Add a separate `tier` column on `plan_details` read alongside `gateProfile`.
  More flexible, more surface area. Defer.

The CTO still emits a triage verdict, but it now **sets the profile at plan
create** (`plan create --gate-profile solo|light|dev_team`), so the gate count is
fixed structurally before any agent wakes — not re-decided per heartbeat by a
prompt the model can ignore.

### Layer 2 — Tier → gate-approval set (the real enforcement)

Make `buildGateApprovalsForActivation` tier-aware (`plan-gates.ts:65`):

| Tier | Gates emitted | Agents woken |
|---|---|---|
| **solo** | none | Implementor only (≈ synchronous single-context model) |
| **light** | 1 review gate (Code Reviewer *or* Wiring Expert, chosen by change nature) | Implementor + 1 reviewer |
| **full** (`dev_team`) | plan-approval + code-review + wiring × every leaf (today) | Architect + 2 reviewers |

The function signature gains a `tier` param resolved by Layer 0+1; the loop emits
0 / 1 / 3 specs. `evaluateDevTeamDoneReadiness` (`plan-gates.ts:101`) must also
branch on tier: solo/light should not require `missing_pr` + both review gates —
that's the exact wall HIV-13 hit.

**Reviewer selection for `light`** (deterministic, not model-chosen): logic/
security change → Code Reviewer; new wiring/registration/entrypoint → Wiring
Expert; if both apply → escalate to `full`.

---

## Scope

**In scope**
- Layer 0: `gate-triage.ts` hard-rule enforcer (pure, tested).
- Layer 1: `PlanGateProfile` gains `solo`/`light`; CLI `plan create` accepts them.
- Layer 2: `buildGateApprovalsForActivation` + `evaluateDevTeamDoneReadiness`
  become tier-aware.
- CTO prompt: emit the triage verdict and pass `--gate-profile` accordingly.

**Out of scope**
- Per-wake context cost, empty-instruction burns, session strategy — these are
  **not** fixed by triage (triage only reduces *how many* agents wake). Tracked
  separately in `wake-cost-and-readiness-plan.md` (companion).
- Auto-classification by static analysis / ML — CTO judgment + Layer 0 floor only.
- Changing reviewer checklist content.

---

## Files

- **Add** `server/src/services/gate-triage.ts` — hard-rule floor (pure).
- **Add** `server/src/__tests__/gate-triage.test.ts`.
- **Modify** `packages/shared/src/types/issue.ts:266` — extend `PlanGateProfile`.
- **Modify** `server/src/services/plan-gates.ts:65,101` — tier-aware gate set +
  done-readiness.
- **Modify** `server/src/services/plans.ts:294` — pass resolved tier into gate
  build at activation.
- **Modify** `cli/src/commands/client/plan.ts` — accept `solo`/`light` profiles.
- **Modify** `teams/agent-team/prompts/cto.md` — triage verdict → sets profile.

No DB migration if Layer 1 option (a) — `gateProfile` column already stores a
string.

---

## Acceptance criteria

- A `solo` docs task (re-run HIV-12) ships through **Implementor only** — no
  Architect/Code-Reviewer/Wiring runs, no plan-approval gate — and closes without
  the `missing_pr` wall. Token cost drops to single-session order (~15–120k).
- A task touching any hard-rule surface (auth/payments/migration/secrets/public
  API / >N files) is forced to `full` by Layer 0 **even if the CTO requested
  `solo`** — proven by a unit test that feeds a solo request + an auth path.
- `light` wakes exactly Implementor + one reviewer; the done-gate requires that
  one gate, not both.
- Tier is persisted on the plan and visible on the board; downgrades from full
  carry the CTO's `reason`.

---

## Risks

| Risk | Mitigation |
|---|---|
| Misclassification skips needed review | Layer 0 server-side floor overrides model; uncertain → escalate, never lower |
| Tier creep back to full | Track tier distribution in `pilot-log.md`; Layer 0 only forces *up* |
| `light` picks wrong single reviewer | Deterministic rule; both apply → `full` |
| Done-gate branch misses a tier | Unit-test `evaluateDevTeamDoneReadiness` for all three tiers |

---

## Sequencing

1. **Layer 0** — `gate-triage.ts` floor + tests. No behavior change yet; just the
   classifier.
2. **Layer 1** — extend profile enum + CLI. Back-compat: `dev_team` ≡ `full`.
3. **Layer 2** — tier-aware gate build + done-readiness. Re-run HIV-12 as `solo`,
   measure token delta vs the 300–500k baseline.
4. Run mixed B1 tasks; record tier distribution + cost in `pilot-log.md`.

---

## What this plan does NOT fix (companion work)

Triage cuts *how many* agents wake. It does not touch *what each wake costs*:

1. **Per-wake transcript replay** — resumed sessions re-send the full growing
   transcript at full price (no Anthropic prompt caching; heartbeats outlive the
   5-min cache TTL).
2. **Empty-instruction burns** — no pre-wake readiness gate; a lobotomized agent
   (empty managed bundle) wakes and flails (Architect: 1.17M tokens, zero output).
3. **Session strategy is uniform** — reviewers resume fat implementor sessions
   they don't need.

See `wake-cost-and-readiness-plan.md` for those three.

---

## Related docs

- `platform-burn-guard-plan.md` — cost ceiling (this plan reduces cost *demand*).
- `wake-cost-and-readiness-plan.md` — per-wake cost + readiness (companion).
- `b1-gap-fix-plan.md` — protocol-adherence fixes.
- `pilot-log.md` — B1 run evidence.
