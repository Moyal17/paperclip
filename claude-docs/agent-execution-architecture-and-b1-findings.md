# Agent Execution Architecture & B1 Pilot Findings

> Authoritative reference written 2026-06-14, grounded in a five-front code audit
> (heartbeat lifecycle, session/workspace, cost→budget loop, approval/gate feedback,
> adapter transport) plus a skeptical audit of the burn-guard we shipped. Every
> claim carries a file:line. Where a number may drift, treat it as a signpost, not
> a contract.
>
> **Relationship to existing docs** (read these as canonical for their scope):
> - `docs/start/architecture.md` — top-level system architecture.
> - `docs/guides/agent-developer/heartbeat-protocol.md` — the heartbeat contract.
> - `docs/guides/agent-developer/task-workflow.md` — task/issue workflow.
> - `docs/execution-semantics.md`, `docs/LOW-TRUST-PRESETS.md`, `docs/UNTRUSTED-PR-REVIEW.md` — execution + trust model.
> - `~/docs/myhive-backend-overview.md`, `~/docs/myhive-frontend-overview.md` — MyHive feature overviews.
>
> This doc is the **cost/runaway/B1 synthesis** those don't cover: how a wake
> actually spends tokens, where it's wasted, what B1 proved, what we fixed, and
> what's left. Companion plans: `triage-gate-plan.md`, `wake-cost-and-readiness-plan.md`,
> `platform-burn-guard-plan.md`, `b1-gap-fix-plan.md`, `pilot-log.md`.

---

## 1. The run lifecycle spine (canonical order)

One heartbeat run, start to finish. File refs are `server/src/services/heartbeat.ts`
unless noted.

```
WAKE
  enqueueWakeup(agentId, opts)                         :9824
    ├─ pre-wake gate stack (see §3)                    :9941–10019
    ├─ insert agentWakeupRequests (status=queued)      :10520
    ├─ insert heartbeat_runs (status=queued)           :10537
    └─ startNextQueuedRunForAgent()                    :7550
CLAIM
  claimQueuedRun()                                     :6632
    ├─ same pre-wake gates re-checked (budget, pause)  :6648–6707
    ├─ queued → running                                :6710
    └─ stamp issue execution lock (executionRunId)     :6747
EXECUTE
  executeRun(runId)                                    :7628
    ├─ resolve runtime / session / task-session        :7661–7809
    ├─ build adapter config (maxTurns clamp here)      :7830–8094
    ├─ realize execution workspace (cwd)               :8135–8297
    ├─ acquire environment lease                       :8343
    ├─ assemble context (buildPaperclipWakePayload)    :2375 / :7901
    ├─ mint short-lived agent JWT                      :8759
    └─ adapter.execute({context,runtime,config,...})   :8797   ← the LLM/CLI call
FINALIZE
    ├─ determine outcome (succeeded/failed/timed_out)  :8895
    ├─ resolve next session state                      :8907
    ├─ setRunStatus (terminal)                         :9003
    ├─ classifyAndPersistRunLiveness                    :9019 → run-liveness.ts:292
    ├─ refresh continuation summary (async)            :9040 → issue-continuation-summary.ts:242
    ├─ per-run token-ceiling check (SUPPRESSION ONLY)  :9058  ← see §7 gap
    ├─ releaseIssueExecutionAndPromote (deferred wakes):9103
    ├─ handleRunLivenessContinuation (plan_only/empty) :9104 → :4614
    ├─ handleSuccessfulRunHandoff                       :9105 → :4798
    ├─ updateRuntimeState → costs.createEvent          :9165 → :7530
    └─ persist task-session state                       :9168
```

**Non-obvious stages worth knowing:**
- The issue **execution lock** is stamped at *claim*, not at run creation (`:6747`). A run stuck `queued` never locks its issue.
- `releaseIssueExecutionAndPromote` (`:9363`) runs in a transaction and promotes **all** `deferred_issue_execution` wakes for that issue — this is the cross-agent chain trigger.
- Continuation summary refresh is **async/fire-and-forget** (`issue-continuation-summary.ts:163`); silent failure leaves a stale summary.
- Liveness states (`run-liveness.ts:292`): `completed`/`advanced`/`blocked` are terminal; `plan_only`/`empty_response` are eligible for **bounded continuation**; `failed` may schedule a **transient retry**.

---

## 2. Session continuity & context cost (the expensive part)

- Sessions ARE reused: task-keyed `agentTaskSessions` + Claude CLI `--resume <id>` (`claude-local/src/server/execute.ts:680`).
- On resume, **instructions are NOT re-sent** — explicit token saver (`execute.ts:697`).
- `taskKey` derivation: `contextSnapshot.taskKey ?? taskId ?? issueId ?? payload.* ?? null` (`heartbeat.ts:1985`). A changed taskKey → new session.
- **Resume is force-broken** (cold start) by: no session id, prompt-bundle-key mismatch, **cwd mismatch**, remote-target mismatch (`execute.ts:593–609`); or `forceFreshSession` / control-interaction wakes (`heartbeat.ts:2025–2033`).
- **cwd is stable** across runs in worktree mode — deterministic branch path (`workspace-runtime.ts:1127–1209`) — so implementor multi-run sessions stay warm.
- **No Anthropic prompt caching** anywhere; `prompt-cache.ts` is a content-hash bundle key, not `cache_control`. Spaced wakes (> 5-min TTL) replay the full transcript at full price.
- **Session rotation/compaction EXISTS** (`adapter-utils/src/session-compaction.ts:23-27`: `maxRawInputTokens 2M`, `maxSessionRuns 200`, `maxSessionAgeHours 72`) **but is disabled for native-context adapters incl. `claude`** (`:32-37`). The mechanism to cap transcript growth is built and turned off for the adapter B1 used.
- Continuation summary is **deterministic, ≤8k chars**, refreshed every run (`issue-continuation-summary.ts:136`) — a cheap ready-made minimal payload.

---

## 3. Pre-wake gate stack (where runs get blocked)

In `enqueueWakeup` (`:9941–10019`), each calling `writeSkippedRequest(...)`:
1. company inactive → `company.inactive` (`:9878`)
2. budget block → `budget.blocked` (`:9946`, via `budgets.getInvocationBlock` `budgets.ts:817`)
3. **breaker trip** → `breaker.tripped` (`:9956`, via `run-breaker.ts:134`)
4. agent not invokable → `agent.not_invokable` (`:9964`)
5. heartbeat disabled / wake-on-demand disabled (`:9978`/`:9982`)
6. active pause hold → `issue_tree_hold_active` (`:9988`)

`claimQueuedRun` re-checks budget + pause + blockers + staleness (`:6648–6707`).

**Gaps in the stack** (the wasteful wakes): there is **no idle short-circuit** (every timer wake spins a full run to discover no work) and **no instruction-readiness check** (an empty managed bundle runs anyway). These are the two pure-waste leaks — see §6.

---

## 4. Cost → pause → incident → resume loop

- Adapter usage captured → `updateRuntimeState` → `costs.createEvent` (`heartbeat.ts:7530`, `costs.ts:66`).
- `createEvent` updates rolling monthly spend, then calls `budgets.evaluateCostEvent` (`costs.ts:99`).
- `evaluateCostEvent` (`budgets.ts:699`) finds active policies for the scope, computes observed amount (`computeObservedAmount:166`), and on hard-stop: pauses scope + raises incident + cancels work (`:741–813`).
- **Metric matters:** `total_tokens` sums `input+cached+output` regardless of billing; `billed_cents` sums `costCents` (≈ $0 for subscription runs). This is why **token caps bite on subscription runs, dollar caps don't** (`budgets.ts:195`).
- Pause sets `agents.status=paused, pauseReason=budget` (`:255`). `getInvocationBlock` (`:817`) then blocks future wakes by checking that paused status (not the incident row directly).
- Resume: operator resolves incident `raise_budget_and_resume` → policy amount raised + `resumeScopeFromBudget` clears the pause (`:1025`, `:312`). `keep_paused` dismisses without resuming.

**Burn guard we shipped (G1–G5), confirmed wired:**
- G1 config: `instanceSettings.guards` jsonb + `getGuards()` defaults (`instance-settings.ts:182`, defaults in `shared/src/types/instance.ts`).
- G2 auto-arm: token policies upserted on company/agent create (`routes/companies.ts:340`, `routes/agents.ts:2365`).
- G3 turns floor: `maxTurnsPerRun = min(agent, platform)` (`heartbeat.ts:8084`). ✅
- G4 breaker: wake-rate (1h window on `heartbeatRuns`) + consecutive-same-issue (via `contextSnapshot.issueId`), wired into `enqueueWakeup` (`run-breaker.ts:134`, `heartbeat.ts:9953`). ✅
- G5: Guardrails UI + route + sidebar + 9 tests (`InstanceGuardrailsSettings.tsx`, `App.tsx:97`, guard-*.test.ts). ✅

---

## 5. Gate / approval feedback loop + the two gate systems

**Two independent gate systems — do not conflate:**
1. **dev_team plan gates** — `buildGateApprovalsForActivation` (`plan-gates.ts:65`) creates approval rows directly: 1 plan-approval + (code-review + wiring) × every leaf. Fixed at maximum. Done-gate `evaluateDevTeamDoneReadiness` (`:101`) hard-blocks `done` for an **agent** actor until `prUrl` + both review gates are approved; a **user/board** actor overrides (audited, `routes/issues.ts:5135`).
2. **executionPolicy stage machine** — `applyIssueExecutionPolicyTransition` (`issue-execution-policy.ts:1050`), per-issue `stages[]`/`participants[]`. **Never consulted by the dev_team flow.** `reviewPreset`/`authorizationPolicy` are trust-containment flags, not review tiers.

**No risk/scope/file-count classifier exists today** — review requirements are static (dev_team = always 3) or binary (trust preset).

**Decision → wake:** approving an approval with `requestedByAgentId` wakes that agent (`routes/approvals.ts:187`, `reason="approval_approved"`). Reject/agent-decide do not wake. Gate creation itself does **not** wake the designated agent — they discover it via the global cadence (relevant to §6 W5).

**Gate designation is by url-key (agent name), not role:** `resolveByReference(companyId, urlKey)` maps architect/code-reviewer/wiring-expert → agentId, board fallback if missing (`plan-gates.ts:19`, `plans.ts:61`).

---

## 6. What B1 revealed — what went wrong

The B1 pilot shipped a one-line CHANGELOG and cost ~300–500k tokens (CTO 2.2M lifetime, Architect 1.17M, CEO 7.3M, CMO 4.1M, company 13.6M). Four independent root causes:

| ID | What went wrong | Root cause (file:line) | Fix |
|---|---|---|---|
| **C1** | Idle exec agents (CEO/CMO) auto-woke ~24×, burning ~11M tokens with zero output | `tickTimers` wakes every invokable agent on a fixed interval, **no actionable-work check** (`heartbeat.ts:11176`); no idle short-circuit | `wake-cost-and-readiness-plan.md` W2 |
| **C2** | Architect burned 1.17M doing nothing — it had an **empty managed instruction bundle** | `recoverManagedBundleState` returns empty silently (`agent-instructions.ts:282`); adapter runs with null instructions (`execute.ts:450`); **no readiness gate** | W1 |
| **C3** | The actual task agent looped; each wake replayed a growing transcript at full price | Rotation disabled for `claude` (`session-compaction.ts:32`); no prompt cache | W3 |
| **C4** | Full 5-role gate ran for a trivial docs change | dev_team gate profile is fixed-maximum (`plan-gates.ts:65`); no triage tier | `triage-gate-plan.md` |
| **C5** | HIV-13 couldn't reach `done` — done-gate needs a worktree PR the shared-branch run never produced | `evaluateDevTeamDoneReadiness` requires `prUrl` (`plan-gates.ts:113`); only set via git-ops worktree route | tier-aware done-gate (triage Layer 2) + `b1-gap-fix-plan.md` |

Protocol-adherence gaps (CTO self-assigned instead of delegating; auto-heartbeat during setup) are tracked in `b1-gap-fix-plan.md` and `pilot-log.md`.

---

## 7. What we fixed, and one honest gap in our own work

**Shipped (this session):** the burn guard, G1–G5, committed on `pilot/b1-dogfood`. It would have caught B1: the wake-rate breaker stops the 2nd–5th loop wake, the token budget pauses the agent + raises an incident, and the operator resumes via the existing approve-to-resume flow. Re-run of the changelog task (HIV-12/13) completed and both issues closed.

**Honest gap found by the skeptical audit — G3 per-run token ceiling is suppression-only.** The plan called for a mid-run hard kill when cumulative tokens exceed `maxTokensPerRun`. What shipped (`heartbeat.ts:9058–9099`) only **suppresses the next continuation** after a max-turn run already failed — it logs a warning and blocks the retry. A single pathological run can still burn its full tokens in-flight; only the retry is stopped.
- **Impact:** the breaker + windowed budget still bound total burn, but the *first fat run* is not cut off mid-stream.
- **Missing tests:** "run exceeds maxTokensPerRun → cancelled + incident" and "maxTurnsPerRun:1000 → effective 120" were planned but not written.
- **To close:** a cost-event callback during execution (not post-failure) that invokes the run-cancel path, plus the two tests. Small, well-scoped follow-up.

---

## 8. What still needs fixing / improving (priority order)

1. **W1 readiness gate + W2 idle short-circuit** (`wake-cost-and-readiness-plan.md`) — kills C1+C2, the pure-waste burn. Highest ROI; both slot into the existing pre-wake gate stack (§3).
2. **Triage tiers** (`triage-gate-plan.md`) — Layer 0 server-side hard-rule floor + tier-aware `buildGateApprovalsForActivation`. Kills C4; fixes C5 via tier-aware done-gate.
3. **W3 enable Claude session rotation** — flip the disabled flag + tune `maxRawInputTokens`. Caps C3.
4. **G3 hard-kill** — close our own suppression-only gap (§7).
5. **W4 minimal review payload + W5 targeted gate wake** — sharpen per-wake cost and let the global cadence slow down.

Three load-bearing legs, independent: **triage** cuts demand, **wake-cost/readiness** cuts per-wake waste, **burn guard** caps the ceiling.

---

## 9. Secret handling (verified safe — relevant to the "no PAT in agent env" rule)

- The token injected into the adapter is a **short-lived HS256 JWT** scoped to agent+company+adapter+run (`agent-auth-jwt.ts:68`, injected `adapters/registry.ts:468`), used only to call back into the Paperclip API. **Not** a GitHub PAT.
- GitHub auth + git push/PR are **server-side only**, via the secrets service. No GitHub token material enters the adapter env or prompt.
- Logs are redacted for PAT/JWT/Bearer/`sk-` formats (`adapter-utils/src/command-redaction.ts`); remote-execution env is sanitized before SSH (`remote-execution-env.ts`).
- **Conclusion:** the "no PAT in agent env" rule is enforced by architecture, not convention.

---

## 10. Confidence & open edges

Confirmed at file:line: run lifecycle spine, session continuity + rotation, context assembly, pre-wake gate stack, cost→pause→incident→resume loop, the two gate systems, approval→wake feedback, adapter transport + secret handling, org/delegation, and the actual shipped burn-guard surface (incl. the G3 gap).

Open edges (not blockers, flagged honestly):
- **W4 diff source** — confirm a clean per-issue diff is available to the payload builder without a git-ops worktree (the path C5 hit). 5-min check before building W4.
- **W3 tuning value** — `maxRawInputTokens` start point is a guess; measure.
- **W5 cadence raise** — safe only after W2 lands; needs the idle-skip first.

---

## 11. Related-doc index (paths)

| Doc | Path | Scope |
|---|---|---|
| System architecture | `docs/start/architecture.md` | top-level (canonical) |
| Heartbeat protocol | `docs/guides/agent-developer/heartbeat-protocol.md` | wake contract |
| Task workflow | `docs/guides/agent-developer/task-workflow.md` | issue lifecycle |
| Execution semantics | `docs/execution-semantics.md` | run/exec model |
| Low-trust presets | `docs/LOW-TRUST-PRESETS.md` | trust model |
| Dev-team factory | `claude-docs/dev-team-factory-overview.md` | the gate factory |
| Burn guard plan | `claude-docs/platform-burn-guard-plan.md` | shipped G1–G5 |
| Triage plan | `claude-docs/triage-gate-plan.md` | right-size gates |
| Wake-cost & readiness | `claude-docs/wake-cost-and-readiness-plan.md` | per-wake cost + W1/W2 |
| B1 gap fixes | `claude-docs/b1-gap-fix-plan.md` | protocol adherence |
| Pilot log | `claude-docs/pilot-log.md` | B1 evidence |
| MyHive backend | `~/docs/myhive-backend-overview.md` | feature overview |
| MyHive frontend | `~/docs/myhive-frontend-overview.md` | feature overview |
| **This doc** | `claude-docs/agent-execution-architecture-and-b1-findings.md` | cost/runaway/B1 synthesis |
