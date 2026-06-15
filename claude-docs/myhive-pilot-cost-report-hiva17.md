# MyHive Pilot — Cost & Effort Report: HIVA-17

**Feature shipped:** `GET /api/companies/:id/plans` list endpoint (+ tests)
**Run date:** 2026-06-15
**Company:** Hive Pilot (`18b55ef9`)
**Gate profile:** `dev_team` (full: plan-approval → code-review → wiring-review)
**Branch:** `pilot/b1-dogfood` — commit `094a5b57`

This is the first end-to-end MyHive pilot of a real feature through the full
agent-company gate chain. Captured here so it can be compared head-to-head against the
same task driven by `/dev-roles` (single-context role-switching).

---

## 1. What shipped

| File | Change | Lines |
|---|---|---|
| `server/src/services/plans.ts` | `listPlans(companyId, { state })` service | +29 −1 |
| `server/src/routes/plans.ts` | `GET /companies/:id/plans` route + `listPlansQuerySchema` | +19 |
| `server/src/__tests__/plans-list.test.ts` | 4 integration tests (empty, single draft, state filter, 403) | +159 |

**Total: 206 insertions, 1 deletion, 3 files.** Tests: 4 passing. `tsc --noEmit`: clean.
Code-review verdict: APPROVED, 0 blocking, 1 LOW (free-text `state` not enum-validated —
acceptable). Wiring-review: APPROVED.

A single small backend feature — one route, one service fn, one test file.

---

## 2. Token spend (authoritative — budget ledger `observedAmount`)

| Agent | Tokens | Notes |
|---|---:|---|
| **CTO** | 4,745,639 | Highest by far — ran 8+ times (decompose, delegate, retries, 1 transient-upstream failure, cold `--resume` replays each reload full transcript) |
| **Architect** | 1,780,089 | One 535s plan-approval review |
| **Code Reviewer** | 1,225,754 | One 371s review pass (blew the 500k cap → paused mid-pilot) |
| **Wiring Expert** | 972,563 | One 335s review pass (blew the 500k cap → paused mid-pilot) |
| Implementor 1 / 2 | *not tracked* | No per-agent budget policy; folded into company total only |
| **Agent subtotal (4 tracked)** | **8,724,045** | |
| **Company total (June UTC)** | **9,062,647** | Includes implementor spend + earlier aborted attempts/replays this month |

**~9.06M tokens** to ship a 206-line, 3-file backend endpoint.

### Where the tokens went (the honest part)
- **The CTO is the cost sink (52% of tracked spend).** Each wake cold-replays its full
  `--resume` transcript before doing any new work. 8+ wakes → the transcript is re-read
  8+ times. This is the same burn pattern flagged in the A1a session-rotation note.
- **Reviewers cost ~1M each** for a single pass over a 206-line diff — they read full
  files, ran the test suite, and ran `tsc`. Thorough, but ~5,000 tokens per line reviewed.
- The 500k per-agent cap was set far below one real review pass (~1M), so **both
  reviewers hit the budget hard-stop mid-run** and had to be manually unpaused + their
  caps raised. That recovery overhead is operational, not feature work.

---

## 3. Time

| Metric | Value |
|---|---|
| Successful-run compute time | **34.8 min** (10 succeeded runs) |
| All-run compute time (incl. 9 cancelled + 1 failed) | **60.3 min** |
| Wall-clock span (first run → wiring done) | **06:32 → 17:17 UTC ≈ 10h45m** |

**Compute ≠ wall-clock.** The 10h45m span is dominated by idle gaps: overnight pause, the
user stepping away, manual budget-incident recovery, and re-wakes after stalls. Pure
agent compute on the *successful* path was **~35 minutes**; with all the failed/cancelled
attempts (assignee-change cancellations, budget blocks, the detached implementor run, a
631s transient-upstream CTO failure) it was **~60 minutes**.

### Run ledger (20 runs total: 10 succeeded, 9 cancelled, 1 failed)

| Time (UTC) | Agent | Status | Dur | Note |
|---|---|---|---|---|
| 06:32–06:36 | CTO | succeeded ×4 | ~100–130s ea | decomposition / delegation passes |
| 07:05 | CTO | **failed** | 631s | `claude_transient_upstream` |
| 12:13 | CTO | succeeded | 222s | |
| 14:56 | Impl 1 | succeeded | 60s | on-demand |
| 15:10–15:12 | Impl 1 | cancelled ×2 | — | |
| 16:01 | **Architect** | succeeded | 535s | plan-approval gate ✅ |
| 16:10 | CTO | cancelled | 189s | caught mid-run by snapshot |
| 16:21 | CTO | succeeded | 108s | delegate child to Impl 2 |
| 16:28 | **Impl 2** | cancelled | 599s | wrote the code, then run **detached** on dev-server hot-reload |
| 17:06 | **Code Reviewer** | succeeded | 371s | code-review gate ✅ |
| 17:12 | **Wiring Expert** | succeeded | 335s | wiring-review gate ✅ |
| (earlier) | Wiring/Arch/Impl1/CTO | cancelled ×4 | — | `issue_assignee_changed` / `budget_blocked` (pre-fix) |

---

## 4. Friction encountered (not feature work, but it cost time + tokens)

1. **Gate-wake assignee-change cancellations** — architect + reviewer wakes were killed as
   `issue_assignee_changed` until the exemption fix (`f9bd880f`) shipped. Pre-fix runs
   show as cancelled in the ledger.
2. **Budget hard-stop** — per-agent 500k cap < one review pass (~1M). Both reviewers and
   the CTO paused mid-chain; required manual incident resolution to continue.
3. **Self-reload** — Impl 2's 599s run wrote the code but **detached** because editing the
   watched repo hot-reloaded the dev server. Code survived (committed), run was lost.
4. **dev_team done-gate needs an open PR** — both gates approved but the child stays
   `in_review`; an agent can't mark it `done` without `prUrl` (pilot opens no upstream PR).
   Requires an operator override to close.

Items 1–3 are now understood/fixed or backlogged (worktree isolation = backlog G).

---

## 4b. Audit of the code the agents produced

A fresh-eyes review of the actual shipped diff (`094a5b57`) — separate from the agents'
own gate reviews. **Verdict: the code is correct, secure, and matches the AC for what it
does.** But the agent reviewers approved with only one LOW finding, and a thorough human
review surfaces several things they missed. None are blocking; the value is in seeing
*what the agent gate chain let through*.

### What the agents got right (credit where due)
- Projection matches the AC exactly (`issueId, title, state, gateProfile, assigneeAgentId, createdAt`).
- Correct plan-root identification: `innerJoin(issues)` + `isNull(issues.parentId)`.
- Real authz: `assertCompanyAccess` runs before the query; 403 cross-company proven against real SQL.
- Query rides the composite index `(company_id, state)`; newest-first + `?state=` both tested on embedded Postgres.
- Clean input validation (400 on bad query), `tsc --noEmit` clean.

### What they missed

| # | Severity | Finding | Detail |
|---|---|---|---|
| 1 | **MEDIUM** | **No result limit / pagination** | `listPlans` returns *every* matching row unbounded (`server/src/services/plans.ts`). Peer list queries in `issues.ts` use `.limit()`. A company with many plans returns an unbounded payload. The AC didn't ask for it, but it's the most material omission for a list endpoint — both agent reviewers missed it. |
| 2 | **MEDIUM** | **Board/user authz path untested** | The endpoint is documented "board/agent dashboard" and `assertCompanyAccess` (`routes/authz.ts:58–73`) has a whole board-actor branch (membership + viewer rules). All 4 tests use **agent** actors only. The primary consumer — a board user — is unverified: neither the allowed-board `200` nor the denied-board `403` is covered. |
| 3 | LOW | **Malformed `companyId` → likely 500, not 400/404** | The `:companyId` param isn't UUID-validated (unlike `projectId` in `createPlanSchema`, which uses `.uuid()`). A non-UUID matching the actor's company reaches `eq(planDetails.companyId, …)` → Postgres `invalid input syntax for type uuid` → 500. Untested edge. |
| 4 | LOW | **Lists `cancelled` / `done` plan roots** | No `status` filter. (Issues has no soft-delete — reset uses hard `DELETE` — so no *deleted* rows leak.) But a cancelled plan still appears. Debatable; AC didn't specify. A product decision, not a bug. |
| 5 | LOW | **Unstable sort on `createdAt` ties** | `orderBy(desc(issues.createdAt))` has no tiebreak; same-millisecond inserts order nondeterministically. The state-filter test happens to rely on sequential timestamps. Add `desc(issues.id)` for determinism. |
| 6 | LOW | **Result-scoping isolation not directly tested** | The 403 test proves cross-company *denial*. There's no test seeding company A *and* B plans, querying as A, asserting only A's rows return (result-level tenant scoping). The `companyId` WHERE makes it correct, but it's a missing regression guard. |

### Takeaway
The agent gate chain (`code-review APPROVED, 1 LOW` + `wiring APPROVED`) was **not wrong** —
everything it asserted is true. It was **not exhaustive**: it validated the happy path it
was told to build and missed the unbounded-list scalability gap (#1) and the
untested-primary-consumer gap (#2) that a senior human reviewer would flag. For a
206-line endpoint that cost ~9M tokens of review, the reviewers caught one free-text-enum
nit but not the two most useful findings. Worth weighing against the `/dev-roles` review
quality in the comparison below.

---

## 5. Bottom line

| | This pilot (MyHive `dev_team`) |
|---|---|
| Feature size | 206 lines, 3 files, 4 tests |
| Tokens | **~9.06M** (company month); 8.72M across 4 tracked agents |
| Compute (happy path) | ~35 min |
| Compute (all attempts) | ~60 min |
| Wall-clock | ~10h45m (mostly idle/recovery) |
| Runs | 20 (10 ok / 9 cancelled / 1 failed) |
| Gates passed | plan-approval ✅, code-review ✅, wiring-review ✅ |

The agent-company path produces a fully-reviewed, multi-gate-approved change with an
audit trail — but at **~9M tokens and 20 runs for a 206-line endpoint**, dominated by CTO
transcript replay and per-pass reviewer cost. Much of the run count is recoverable
friction (gate-wake cancellations, budget stops, self-reload) rather than intrinsic cost.

---

## 6. `/dev-roles` comparison

Same task — `GET /api/companies/:id/plans` — driven by `/dev-roles full` in a single
context (CTO → Architect → Implementor → Code Reviewer → Wiring Expert, all played by one
model, no async wakes, no transcript replay, no budget machinery). Run in a clean
pre-feature worktree (`bench/dev-roles-plans` @ `945754dc`) so it built from scratch,
blind to the pilot's implementation. Full run summary: `~/docs/dev-roles-bench-list-plans-run.md`.

| Metric | MyHive `dev_team` | `/dev-roles full` |
|---|---|---|
| Tokens | **~9.06M** (budget ledger, replay-heavy/uncached) | **~5.64M processed** (5.4M cache read + 201k cache write + 42.5k fresh) |
| Billed cost | not captured as $ — but token mix is cold-`--resume` replay (mostly **uncached** → high $/token) | **$5.45** (95%+ cache reads → cheap) |
| API compute | ~35–60 min | **8m 14s** |
| Wall-clock | ~10h45m | **31m 54s** |
| Runs / passes | 20 (10 ok / 9 cancelled / 1 failed) | 1 pass per role, 0 cancellations |
| Gate cycles | plan + 2 reviews, w/ friction | plan ✅ · code ✅ · wiring ✅, all **cycle 1** |
| Lines shipped | 206 (3 files) | **301 added** (3 files; same projection + join + sort, larger test file) |
| Gates | 3 ✅ | 3 ✅ |

**The token gap understates the cost gap.** `/dev-roles` processed ~5.64M tokens but **95%+
were cache reads** (one warm context, re-read cheaply) → **$5.45 total**. The agent-company's
9.06M is dominated by CTO cold-`--resume` replays that start a **fresh** session each wake →
cache misses → far higher $/token. So on actual spend the gap is much wider than 9M-vs-5.6M
suggests: `/dev-roles` shipped *more* code (301 vs 206 lines) for a single-digit-dollar cost,
in **8 min of compute / 32 min wall** vs the pilot's hours.

> External confirmation from the bench session's `/cost` breakdown: *"81% of usage came from
> subagent-heavy sessions"* and *"81% from sessions active 8+ hours"* — that's the MyHive pilot
> babysitting, not the `/dev-roles` arm (which was 12% of usage, one short session).

### Code produced — essentially identical
Both arms converged on the same implementation: `plan_details INNER JOIN issues`, projection
`{issueId,title,state,gateProfile,assigneeAgentId,createdAt}`, `ORDER BY issues.createdAt DESC`,
added `desc` to the drizzle import, optional `?state=` filter, `assertCompanyAccess` first.
No meaningful divergence in the shipped code.

### Review quality — a near-tie, and the same blind spots
- **Both** code reviewers landed exactly one LOW: `?state=` is an unvalidated open string
  (unknown state → `[]`, not 400). Same finding, both accepted it.
- **Both missed the same two things** from the §4b audit: no result limit / pagination (#1),
  and the board/user authz path being untested (#2). Neither arm caught the two most useful gaps.
- **`/dev-roles` had one edge:** its **plan gate** (architect, pre-code) caught that `createdAt`
  must come from `issues` not `plan_details`, and that the 403 test must mount `errorHandler` —
  defects prevented *before* code. The async agent chain surfaced no equivalent pre-code catch.

### Verdict
For this task, the agent-company's **~9M tokens and 20 runs** bought **neither better code nor
better review** than `/dev-roles` in one context, minutes, zero cancellations. What the extra
cost *did* buy is the agent-company's actual product: a durable async audit trail, real
per-agent isolation, parallel reviewers, and operability under the budget/kill-switch control
plane — properties `/dev-roles` structurally cannot provide (it's one synchronous context).

So the comparison isn't "which is better" — it's **what you're paying for**. If the goal is to
*ship a small feature*, `/dev-roles` wins decisively on cost/speed at equal quality. If the goal
is to *exercise the autonomous control plane* (the whole point of the MyHive pilot), the 9M is the
cost of the infrastructure being real, and the optimization targets are the friction sinks in §4:
CTO transcript replay, per-pass reviewer cost, and the recoverable-friction run count — not the
feature itself.

> **Token line pending:** `/dev-roles` token total isn't self-measurable from inside the agent.
> Fill from the CLI session `/cost` for the bench conversation.
