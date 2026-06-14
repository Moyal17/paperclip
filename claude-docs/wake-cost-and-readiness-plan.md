# Wake-Cost & Readiness Plan — make each wake cheap, and never wake a broken or idle agent

> Written 2026-06-14, companion to `triage-gate-plan.md`. Triage reduces *how many*
> agents are gated. This plan attacks *what each wake costs* and *whether a wake
> should happen at all*. Grounded in a five-front audit of the heartbeat,
> workspace, session-rotation, execution-policy, and org subsystems.
>
> Headline finding: most of the machinery to fix this **already exists and is
> either turned off or never consulted.** This is mostly wiring + gates, not new
> subsystems.

---

## Key architecture facts this plan is built on (verified)

| Fact | Evidence | Consequence |
|---|---|---|
| Session resume works; instructions NOT re-sent on resume | `claude-local/src/server/execute.ts:680,697` | Warm path already saves 5-10k tok/wake |
| CWD is **stable** across runs in worktree mode (deterministic branch path) | `workspace-runtime.ts:1127-1209` | `--resume` stays valid for multi-run implementors; sessions stay warm |
| Session rotation/compaction **exists** with a token-budget trigger… | `adapter-utils/src/session-compaction.ts:23-27` (`maxRawInputTokens: 2M`) | …mechanism is built |
| …but is **DISABLED for the `claude` adapter** (native-context list = 0 thresholds) | `adapter-utils/src/session-compaction.ts:32-37` | The exact adapter B1 uses never rotates → unbounded transcript |
| No Anthropic prompt caching anywhere (`prompt-cache.ts` = content-hash key only) | adapter audit | Spaced wakes (> 5-min TTL) replay full transcript at full price |
| Review/approval wakes already **force a fresh session** | `heartbeat.ts:2027-2033` | Reviewers don't inherit the fat implementor transcript (good) |
| **No idle short-circuit** — every wake spins a full run to discover no work | `heartbeat.ts` enqueue path; `tickTimers:11176-11221` wakes ALL invokable agents | Idle exec agents (CEO/CMO 24×) burn context to learn they're idle |
| **No instruction-readiness check** — empty managed bundle runs anyway | `agent-instructions.ts:282`, `execute.ts:450` | Lobotomized agent burns tokens flailing (Architect: 1.17M) |
| Continuation summary is deterministic, ≤8k chars, refreshed every run | `issue-continuation-summary.ts:136-209` | A cheap, ready-made minimal payload for stateless reviewers |
| Gates create inbox approvals; they do **not** wake the designated agent | `plan-gates.ts`, org audit | Gate agents rely on global cadence to discover work |
| Pre-wake gate stack already exists (budget → breaker → invokable → pause hold) | `heartbeat.ts:9941-10019`, each `writeSkippedRequest(...)` | New gates slot in cleanly beside these |

---

## Cost decomposition — four independent drivers

| ID | Driver | Mechanism | Magnitude (B1) |
|---|---|---|---|
| **C1** | **Idle wakes** | Global `tickTimers` wakes every invokable agent regardless of work; no actionable-work gate | CEO/CMO ~24× wakes, ~11M tok, zero output |
| **C2** | **Empty-instruction burns** | No readiness gate; empty managed bundle runs anyway | Architect 1.17M tok, zero output |
| **C3** | **Transcript replay** | Rotation disabled for `claude`; no prompt cache; spaced wakes replay growing transcript at full price | CTO 2.2M lifetime on a one-liner |
| **C4** | **Uniform session strategy** | All resuming agents rebuild context; reviewers don't need it (but already force-fresh — see below) | folded into C3 |

C1 + C2 are **pure waste** (zero-value runs). C3 is the cost of *real* work being unbounded. Kill C1/C2 outright; cap C3.

---

## Fixes — ship order

### W1 — Instruction-readiness gate (ship first; kills C2)

A pre-wake gate that refuses to run an agent with an empty managed instruction bundle.

- **Where:** `heartbeat.ts` `enqueueWakeup`, immediately after the breaker check
  (`~:9954`), and mirrored in `claimQueuedRun` (`~:6648`) so queued runs are caught too.
- **Logic:**
  ```
  if bundleMode(agent) === "managed":
    bundle = getBundle(agent)                       // agent-instructions.ts
    if bundle.rootPath === null || bundle.files.length === 0:
      writeSkippedRequest("agent.instructions_empty")
      pauseAgent(agent, reason: "instructions_empty")   // reuse budget-pause path
      raiseIncident(...)                            // surfaces in the same incident UI
      return  // never invoke the adapter
  ```
- **Cost:** one cheap bundle read, no LLM. ~30 lines. Fail-closed.
- **Why a gate, not just a fix:** the *cause* (unsynced skills) may recur; the gate
  guarantees no tokens are ever spent on a brain-dead agent, exactly like the
  budget hard-stop. Highest ROI item in either plan.

### W2 — Idle short-circuit gate (ship first; kills C1)

Don't spin up a run for an agent that has no actionable work.

- **Where:** `tickTimers` (`heartbeat.ts:11176`) — pre-filter before `enqueueWakeup`;
  and as a skip in `enqueueWakeup` for the `timer` source so on-demand/assignment
  wakes are never blocked.
- **Actionable-work query:** agent has ≥1 assigned issue in (`in_progress`,
  `in_review`) that is not blocked, OR a pending gate/interaction targeting it, OR
  a due monitor. None of those → skip.
  ```
  if wakeSource === "timer" && !hasActionableWork(agent):
    writeSkippedRequest("agent.no_actionable_work")
    return
  ```
- **Critical guardrail:** only short-circuit **timer** wakes. Assignment, gate,
  monitor, recovery, and on-demand wakes always carry intent — never skip them.
- **Impact:** directly removes the CEO/CMO 24× class. Exec agents with no assigned
  work simply don't wake. Pairs with triage (`solo` tasks don't assign exec
  agents, so they stay asleep).

### W3 — Enable + tune session rotation for the Claude adapter (caps C3)

Flip the mechanism that already exists but is off for `claude`.

- **Where:** `adapter-utils/src/session-compaction.ts:32-37` removes `claude` from
  the native-context "rotation-disabled" set, OR set a non-zero
  `maxRawInputTokens` for it. Per-agent override already supported via
  `runtimeConfig.heartbeat.sessionCompaction.maxRawInputTokens`
  (`session-compaction.ts:135-156`).
- **Tuning:** start `maxRawInputTokens` at e.g. 400k for dev-team roles (well under
  the per-run kill ceiling the burn-guard sets). When the resumed transcript
  crosses it, the existing rotation builds the handoff markdown
  (`heartbeat.ts:8095-8107`, already says *"Rebuild only the minimum context you
  need"*) + carries the deterministic continuation summary, and starts a fresh,
  small session. Old transcript cost stops accruing.
- **Why this is safe:** rotation + continuation summary is battle-tested for the
  legacy sessioned adapters; we're enabling an existing path for `claude`, not
  inventing one. The one gap (audit-flagged): rotation is evaluated **pre-run
  only** — fine for our cadence, since wakes are the natural rotation points.

### W4 — Role-based minimal payload for gate agents (sharpens C4)

Reviewers/approvers already force-fresh (`heartbeat.ts:2027-2033`) — so they don't
inherit the implementor transcript. The remaining waste is that a fresh review run
still rebuilds context from the full wake payload. Give it a **purpose-built
minimal payload** instead.

- **Where:** the wake-payload builder (`buildPaperclipWakePayload`,
  `heartbeat.ts:2375`) — branch on wake reason. For
  `execution_review_requested` / `execution_approval_requested`, assemble:
  the diff (or PR link), the acceptance criteria, the reviewer checklist, and the
  ≤8k continuation summary — and **omit** the full comment/run history.
- **Payoff:** a review of a one-line CHANGELOG becomes "here's the diff + the
  checklist," not "reconstruct the whole task." Turns the Architect/Reviewer cost
  from ~1M into ~5-20k.
- **Depends on:** nothing new — the continuation summary
  (`issue-continuation-summary.ts`) already exists and is maintained per run.

### W5 — Targeted gate wake + lower global cadence (compounds C1)

Today gates are discovered passively via the global heartbeat. Make gate creation
wake exactly the designated agent, then it's safe to slow the global tick.

- **Where:** when `buildGateApprovalsForActivation` / gate creation runs
  (`plan-gates.ts:65`, `plans.ts:294`), enqueue a targeted `assignment`-style wake
  for each `designatedAgentId` (reuse `queueIssueAssignmentWakeup`,
  `issue-assignment-wakeup.ts:21`). Same for review-requested transitions.
- **Then:** raise the default per-agent `heartbeat.intervalSec`
  (`heartbeat.ts:6568`) substantially, since work now *pushes* a wake instead of
  agents *polling* for it. With W2 (idle skip) + W5 (targeted wake), the global
  cadence becomes a low-frequency safety net, not the primary driver.
- **Order:** ship after W2 — W2 makes the slow cadence safe; W5 makes it sufficient.

---

## Scope

**In scope:** W1 (readiness gate), W2 (idle short-circuit), W3 (enable Claude
rotation), W4 (minimal review payload), W5 (targeted gate wake + cadence).

**Out of scope:**
- Anthropic API-level prompt caching (`cache_control`) — the adapter shells out to
  the Claude CLI; caching is the CLI's concern. Revisit only if the CLI exposes
  cache controls. W3 makes it moot for spaced wakes anyway.
- Mid-run rotation (rotation is pre-run by design; acceptable).
- Triage tiers — covered by `triage-gate-plan.md`.
- Per-agent budget policy — covered by `platform-burn-guard-plan.md`.

---

## Files

| Fix | File | Change |
|---|---|---|
| W1 | `server/src/services/heartbeat.ts` (`enqueueWakeup ~9954`, `claimQueuedRun ~6648`) | readiness gate + skip reason |
| W1 | `server/src/services/agent-instructions.ts` | expose `isBundleEmpty(agent)` helper |
| W2 | `server/src/services/heartbeat.ts` (`tickTimers:11176`, `enqueueWakeup`) | `hasActionableWork` query + timer-only skip |
| W3 | `packages/adapter-utils/src/session-compaction.ts:32-37` | remove `claude` from disabled set / set non-zero default |
| W4 | `server/src/services/heartbeat.ts` (`buildPaperclipWakePayload:2375`) | branch minimal payload on review/approval wake reasons |
| W5 | `server/src/services/plans.ts:294`, `plan-gates.ts:65`, `issue-assignment-wakeup.ts` | targeted wake on gate create; raise default `intervalSec` |
| all | `server/src/__tests__/wake-readiness.test.ts`, `wake-idle.test.ts` (new) | trip-proof tests |

No DB migration. All changes reuse existing pause/incident/skip/wake plumbing.

---

## Acceptance criteria

- **W1:** an agent with an empty managed bundle is **paused with an incident and
  consumes zero adapter tokens** on wake; restoring instructions clears it. Test
  asserts no `heartbeat_runs` adapter invocation occurred.
- **W2:** a timer wake for an agent with no in-progress/in-review/assigned work,
  no pending gate, no due monitor, is **skipped** (`agent.no_actionable_work`),
  no run created. An assignment/gate/monitor/on-demand wake for the same agent is
  **never** skipped.
- **W3:** a `claude`-adapter session whose replayed input crosses
  `maxRawInputTokens` **rotates** — new run starts with handoff markdown +
  continuation summary, and the next wake's input token count drops below the
  threshold. Re-run a long task and show the per-wake input plateau instead of
  growing.
- **W4:** a review wake's assembled payload excludes full history and includes
  diff + checklist + continuation summary; measured review-run input tokens drop
  by ≥10× vs a full-payload baseline on HIV-12-class tasks.
- **W5:** creating a gate enqueues a wake for the designated agent within one tick;
  with the raised cadence, an idle agent with no work is not woken by the timer.

---

## Risks

| Risk | Mitigation |
|---|---|
| W2 skips a wake that *did* have latent work | Conservative `hasActionableWork` (any assigned non-blocked issue OR pending gate/interaction/monitor); only timer source; on-demand always runs |
| W3 rotates too aggressively, loses needed context | Continuation summary + handoff carry state; tune `maxRawInputTokens` per role; start conservative (400k), measure |
| W4 minimal payload omits something a reviewer needs | Include the PR/diff + acceptance criteria + checklist + full continuation summary; reviewer can request more via interaction if needed |
| W5 targeted wake + slow cadence strands a missed push | Global cadence remains as a low-freq safety net; monitor skip/incident telemetry |
| W1 false-positive on a non-managed agent | Gate only fires for `bundleMode === "managed"`; unmanaged/explicit-instructions agents unaffected |

---

## Sequencing

1. **W1 + W2 together** — pure-waste killers, both pre-wake gates, both ~small,
   both reuse the existing skip/pause plumbing. Biggest immediate token drop.
2. **W3** — one-line-ish enablement + a tuning constant; measure transcript plateau.
3. **W4** — minimal review payload; measure review-run delta.
4. **W5** — targeted wake, then raise cadence; measure idle-wake elimination.

Each lands through the `/dev-roles` gates (architect plan approval, then
code-review + wiring before DONE), per house protocol.

---

## What this plan does NOT fix

- **Real, large, legitimate work** still costs real tokens — these fixes remove
  waste (C1/C2) and cap growth (C3/C4), they don't shrink the irreducible cost of
  a genuinely big task. The triage plan (fewer agents) + burn-guard (hard ceiling)
  are the other two legs.
- **Cross-wake provider caching** — not achievable through the CLI today; W3 is the
  pragmatic substitute.

---

## Related docs

- `triage-gate-plan.md` — right-size *how many* agents gate a task.
- `platform-burn-guard-plan.md` — hard token ceiling (the floor under all of this).
- `b1-gap-fix-plan.md` — protocol-adherence fixes (Fix 4 = company pause during setup, a stopgap for C1 that W2 supersedes).
- `pilot-log.md` — B1 evidence (C1/C2/C3 magnitudes).
