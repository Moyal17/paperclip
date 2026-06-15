# Pilot Feature Backlog

Small, real code-change tasks used to test the MyHive agent pilot. Each requires reading the codebase, writing a route/query change, and adding a test.

## A — `GET /api/companies/:id/plans` list endpoint ✅ piloted
No way to list all plans for a company today. Add route to `plans.ts`, join `plan_details` + root issues, return state + gateProfile + assignee per plan.
- **Files:** `server/src/routes/plans.ts`, `server/src/__tests__/plans-list.test.ts`
- **Complexity:** moderate — new DB query, new route, test
- **AC:** `GET /api/companies/:id/plans` returns array of `{ issueId, title, state, gateProfile, assigneeAgentId, createdAt }` sorted by createdAt desc; 200 empty array when no plans; 403 on wrong company.

## B — Add `agentName` to heartbeat-runs list response
The monitor view does a second lookup for agent name. Add a JOIN in the runs list query, expose `agentName` in response.
- **Files:** `server/src/routes/agents.ts` or `heartbeat-runs.ts`, existing test extended
- **Complexity:** small — one JOIN, one field
- **AC:** runs list response includes `agentName: string | null` on each run.

## C — Add `runCount` + `lastRunAt` to agent list
Agent cards show no run history stats. Add subquery/join to count runs per agent.
- **Files:** `server/src/routes/agents.ts` agents list query, `server/src/__tests__/agents.test.ts`
- **Complexity:** moderate — aggregate subquery
- **AC:** agent list response includes `runCount: number` and `lastRunAt: string | null`.

## E — Mutable per-plan `gateProfile` (PATCH endpoint)
`gateProfile` is set at plan creation and locked. Add `PATCH /api/plans/:id/gate-profile` so the profile can be changed at any lifecycle stage (draft, active). The payload is `{ gateProfile: "dev_team" | "light" | "solo" | "none" }`. Changing while active re-evaluates which gates are pending/skipped — e.g. downgrading dev_team → solo cancels pending architect/reviewer approvals. Upgrading solo → dev_team materializes the missing gate approvals.
- **Files:** `server/src/routes/plans.ts` (new PATCH handler), `server/src/services/plan-gates.ts` (re-triage on change), `server/src/__tests__/plans-gate-profile.test.ts`
- **Complexity:** large — lifecycle mutation; approval rows must be created or cancelled
- **AC:** PATCH returns updated planDetails; downgrade cancels pending non-implementor approvals; upgrade creates missing pending approvals; wrong company → 403; invalid profile string → 400.

## F — CTO autonomous `gateProfile` selection
CTO reads plan description and autonomously selects `gateProfile` before delegating. Plan description should include a recommended profile + rationale (e.g. "Suggested gate: light — touches one route, no auth, no migration"). CTO weighs: scope (files touched), risk flags (auth / payments / migration), size (lines estimate). Writes its decision back via `PATCH /plans/:id/gate-profile` before assigning architect/implementor.
- **Requires E** (mutable gateProfile) to be shipped first.
- **CTO instruction additions:** (1) extract `Suggested gate:` line from overview; (2) if absent, apply heuristic — any risk flag = dev_team, 1–3 files no risk = light, single-function no test = solo; (3) call PATCH to set the profile; (4) log rationale to plan activity.
- **Files:** CTO agent AGENTS.md / skill instructions, `server/src/__tests__/cto-gate-selection.test.ts` (mock plan descriptions, assert PATCH called with correct profile)
- **Complexity:** large — requires E, agent instruction authoring, integration test
- **AC:** Given plan description with `Suggested gate: light`, CTO patches profile to `light` before waking architect. Given no suggestion + risk flag "touches auth middleware", CTO patches to `dev_team`. Given "add one-line alias, no risk", CTO patches to `solo`.

## D — `gateProfile` filter on issues list
`GET /issues?gateProfile=dev_team` — filter issues by their plan's gate profile.
- **Files:** `server/src/routes/issues.ts`, test
- **Complexity:** moderate — conditional join on plan_details
- **AC:** `?gateProfile=` param filters to issues whose root plan matches; ignored when no plan.

## G — Run pilot agents in an isolated git worktree
Pilot agents edit the same repo the dev server (`tsx watch` / `dev:watch`) watches. When an implementor saves a file (e.g. `server/src/routes/plans.ts`), `tsx watch` hot-reloads the server, which restarts the process managing the agent's own run → the run is orphaned with `errorCode: process_detached`, the child issue stalls in `in_progress`, and W5b never fires. Observed live: Implementor 2 wrote the GET /companies/:id/plans endpoint correctly, then its run detached on the reload.

Fix: run pilot agent execution in an **isolated git worktree** (paperclip supports worktree execution) so agent edits land in a separate checkout the dev server does not watch. The server stays stable across agent edits; runs complete cleanly through `in_review` → review gates → done.
- **Why:** removes the self-inflicted server restart mid-run; required for any multi-step dev_team pilot to complete without manual run recovery.
- **Scope:** wire the company/agent execution path to use a worktree checkout for file edits (reuse existing worktree-execution support — see `server/src/worktree-config.ts`, `execution-workspaces.ts`); ensure the agent's adapter writes there, not in the watched tree.
- **Alternatives (inferior):** run the pilot server from a build (`node dist`, no watch); or point agents at a separate clone. Worktree isolation is preferred — closest to how real pilots should run.
- **Complexity:** large — execution-path wiring + verifying adapter cwd.
- **AC:** during a dev_team pilot, an implementor file edit does NOT restart the dev server; the implementor run completes with the child reaching `in_review`; no `process_detached` runs in the pilot.

---

# MyHive vs /dev-roles — competitive goals

Derived from the HIVA-17 benchmark (`claude-docs/myhive-pilot-cost-report-hiva17.md` §6): the
agent-company shipped the same feature as `/dev-roles full` at ~9.06M tokens / hours / 20 runs
vs ~5.64M (95% cache reads) / $5.45 / 8m compute — with equal code and equal review quality.
Track A closes the cost/speed gap; Track B is the quality edge `/dev-roles` structurally can't
replicate.

## Track A — close the cost/speed gap

### A1 — Warm cached agent sessions (kill cold `--resume` replay) — *highest leverage*
CTO transcript replay = **52% of pilot tokens**. Each wake cold-resumes and re-reads the full
transcript → cache miss → full-price tokens, 8×. `/dev-roles` is cheap precisely because it's
one warm context (95% cache reads). Warm MyHive sessions earn the same caching.
- **Scope:** keep an agent's session warm/cached between wakes instead of cold replay; session continuation vs compaction in the heartbeat run path (`server/src/services/heartbeat.ts`, runtime-state/session handling)
- **Complexity:** large — session lifecycle + caching
- **AC:** a multi-wake agent (e.g. CTO across a decomposition) shows cache-read-dominant token usage on wakes 2..n; per-agent `observedAmount` for an equivalent run drops materially vs the 4.75M HIVA-17 CTO baseline.

### A2 — Scope reviewer context to the diff + touched files
Each review pass burned ~1M tokens re-reading the repo for a 206-line change.
- **Scope:** feed code-review / wiring agents the diff and the files it touches, not a full crawl; reviewer wake payload / context assembly
- **Complexity:** moderate
- **AC:** a review pass over a small diff completes well under the ~1M baseline; reviewer still has the touched files in context; gate decisions unchanged.

### A3 — Right-size per-agent budget caps + reset-pilot floor
500k per-agent cap < one real review (~1M) → both reviewers + CTO hit the hard stop mid-chain, needing manual incident recovery (pure overhead). The reset-pilot resolve floor of `+100M` overcorrects (disables the kill switch).
- **Scope:** set per-agent caps to ~5M; change `scripts/reset-pilot.sh` resolve formula floor from `+100M` to ~`+4–5M`
- **Complexity:** small
- **AC:** a full dev_team chain completes without a budget pause; a genuine runaway (cold-resume loop) still trips the cap.

### A4 — Worktree isolation for agent execution
*Already filed as option **G** above — cross-reference, not duplicated.* Agent edits hot-reload the watched dev server → run detaches (`process_detached`), the exact failure that orphaned Impl 2's run. See **G** for full scope + AC.

### A5 — Per-role model tiering
CTO orchestration and mechanical review dimensions don't need Opus; the `/cost` breakdown explicitly flags subagent model cost.
- **Scope:** per-role model config (CTO + mechanical-review on Sonnet/Haiku, keep Opus for architect plan gate + substantive review); agent `runtimeConfig` / adapter model select
- **Complexity:** moderate
- **AC:** CTO + at least one review dimension run on a cheaper model with no gate-quality regression on a benchmark task; total $ for an equivalent chain drops.

## Track B — win on output quality (the edge `/dev-roles` can't match)

### B1 — Distinct-lens parallel reviewers — *the real differentiator*
`/dev-roles` runs reviewers back-to-back in **one shared context** → correlated blind spots (it missed the same `no-pagination` + `untested-board-actor` gaps the pilot did). MyHive reviewers are **independent isolated contexts** — assign each a single lens so catches are uncorrelated. This is how MyHive catches the two gaps both arms missed.
- **Scope:** parameterize review-gate agents with a lens (`scalability`, `test_coverage`, `security_authz`); each reviews only its dimension; gate passes when all lenses approve. Builds on the W5b review-gate wake path (`reviewGateAgentIdsFromApprovals`, `server/src/services/plan-gates.ts`)
- **Complexity:** large — gate model + reviewer prompt/lens assignment
- **AC:** on a task with a known scalability gap (unbounded list query), the scalability-lens reviewer flags it where a single generalist reviewer did not.

### B2 — Completeness critic / adversarial final pass
One context can't easily self-adversary. A dedicated final agent asking "what did the others miss — untested path, unbounded query, unverified claim?" surfaces the tail.
- **Scope:** optional terminal gate agent that runs after code + wiring approve, reads their verdicts + the diff, and either approves or reopens with findings
- **Complexity:** moderate–large
- **AC:** on the HIVA-17 diff, the critic raises at least one of the two audit gaps (pagination / board-actor test) both benchmark arms missed.

### B3 — Persistent cross-task memory for CTO + architect
A `/dev-roles` context forgets at `/clear`; MyHive agents persist. Accumulating repo conventions (paths, patterns, prior decisions) reduces wrong-path file guesses that fresh `/dev-roles` struggles with.
- **Scope:** a small per-agent durable notes store the CTO/architect read at wake and append to on completion (conventions, gotchas), distinct from the run transcript
- **Complexity:** moderate
- **AC:** across two sequential tasks, the architect references a convention learned in task 1 during task 2 without re-deriving it.

### B4 — Adversarial plan gate (front-load catches pre-code)
`/dev-roles`'s one quality win was its architect **catching defects before code** (`createdAt` source, test wiring). The plan gate is the cheapest place to kill a defect.
- **Scope:** strengthen the architect plan-review prompt/criteria to demand projection source-of-truth, test-harness wiring, and scalability/bounds checks at plan time
- **Complexity:** small — agent instruction authoring + a gate test
- **AC:** given a plan that sources a field from the wrong table or omits a result bound, the plan gate rejects with that specific concern before any code is written.

---

# Build priority — what to work on first

Ranked by ROI = impact ÷ effort, with sequencing. Some items are blockers that must land before the big bets pay off. Derived from the HIVA-17 benchmark analysis (§6 of `myhive-pilot-cost-report-hiva17.md`).

| # | Goal | Impact | Effort | Why this rank |
|---|---|---|---|---|
| 1 | **A3** — right-size caps + reset-pilot floor | High (operational) | Small | #1 thing that killed every pilot chain mid-run. 500k cap < one review → budget stalls + manual recovery. Tiny fix, unblocks everything. Do first. |
| 2 | **A4 / G** — worktree isolation | High (operational) | Large | The other hard blocker — agent edits hot-reload the dev server → runs detach (`process_detached`). Without it, pilots can't finish unattended. |
| 3 | **B4** — adversarial plan gate | Med-High (quality) | Small | Cheapest place to kill a defect = pre-code. `/dev-roles`'s only quality win. Prompt/criteria change, fast, real gain. |
| 4 | **A1** — warm cached sessions | Highest (cost) | Large | The 52%-of-spend lever. Biggest $ win, but large/risky — do after the cheap enablers so it's measured on a stable pilot. |
| 5 | **B1** — distinct-lens reviewers | Highest (quality) | Large | Only path to *better* than `/dev-roles`, not just cheaper. Catches the gaps both arms missed. The differentiator. |
| 6 | **A2** — scope reviewer context to diff | Medium (cost) | Moderate | Compounds A1; ~1M/pass → much less. Pairs with B1 (lenses already get scoped context). |
| 7 | **A5** — per-role model tiering | Medium (cost) | Moderate | Easy $ win, no quality risk if Opus stays on the plan gate + substantive review. |
| 8 | **B2** — completeness critic | Medium (quality) | Med-Large | Quality tail-catcher. Overlaps B1; do after, to see what lenses still miss. |
| 9 | **B3** — persistent cross-task memory | Medium (longest horizon) | Moderate | Pays off across many tasks, not one. Last — value compounds once 1–8 make pilots routine. |

## Tiers

- **🔴 Now (unblock):** A3, A4/G — pilots can't reliably complete without these
- **🟠 High ROI:** B4 (cheap quality), A1 (big cost)
- **🟡 Differentiator:** B1, then A2 + A5
- **🟢 Later:** B2, B3

**Call:** ship **A3 → A4 → B4** first (two unblock, one cheap quality), then bet on **A1 + B1** — that pair turns MyHive from "10× cost for parity" into "competitive cost, superior review."
