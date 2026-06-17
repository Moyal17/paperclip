# Pilot Cost Report — HIVA-20/21 "rate-limit the upload route"

**Date:** 2026-06-17
**Company:** Hive Pilot (`18b55ef9`)
**Plan:** "Pilot (full): rate-limit the upload route" (root `0b4133e4`)
**Deliverable:** PR #3 — per-user upload rate limiter (3 files, +365 / -0)
**Profile:** `dev_team` (plan-approval + 3 code-review lenses + wiring + completeness)

---

## Headline

| Metric | Value |
|---|---|
| **Total tokens (company, this run)** | **~35.5M** |
| Total heartbeat runs | 37 |
| Budget incidents raised | 14 (10 approved, 4 rejected) |
| Failed / cancelled runs | 4 failed, 11 cancelled (of 37) |
| Net code delivered | 3 files, 365 lines (1 service, 1 route wiring, 1 test) |
| **Tokens per delivered line** | **~97k tokens/line** |

One small, well-scoped feature (a sliding-window rate limiter) cost ~35M tokens
end-to-end. The implementation itself was cheap; **the orchestration overhead,
model tier, and repeated replays dominated.**

---

## Per-agent token spend

| Agent | Model (during burn) | Tokens | Runs (ok/fail/cancel) | Note |
|---|---|---:|---|---|
| **Architect** | opus | **13.28M** | 6 (2/2/2) | Biggest driver. Opus tier × failed-run replays. |
| **Completeness Critic** | sonnet | **8.40M** | 5 (3/1/1) | Ran the test suite + repo-wide `find\|xargs grep`. |
| **CTO** | opus | **7.53M** | 15 (11/0/3) | Orchestration wakes; opus tier. |
| **Wiring Expert** | sonnet | 3.00M | 4 (3/0/1) | In-budget. |
| **Code Reviewer** | sonnet | 2.99M | 2 (2/0/0) | Cheapest gate — 3 lenses in 2 runs. |
| **SUM** | | **~35.2M** | 37 total | |

---

## Rough cost estimate

> **Estimate only.** `total_tokens` combines input+output (cannot split), and exact
> per-model pricing for the configured tiers is not exposed in the budget data.
> Figures use a blended per-million-token (MTok) proxy.

- **Opus tokens** ≈ 20.8M (Architect 13.3M + CTO 7.5M) — blended ~$30/MTok → **~$625**
- **Sonnet tokens** ≈ 14.4M (Critic 8.4M + Wiring 3.0M + Reviewer 3.0M) — ~$5/MTok → **~$72**
- **Rough total: ~$700** (plausible range **$450–$950** depending on input/output mix
  and cache-hit rate)

The single feature would have been **<$50** if it had run once, clean, on the right
tiers. The 14× cost came from the failure modes below.

---

## Where the tokens went (cost drivers, ranked)

### 1. Architect on opus + failed-run replays — ~13.3M (38%)
The Architect ran on **opus** (≈3× sonnet per token) and had a poor success rate
(2 ok / 2 failed / 2 cancelled of 6 runs). Every cold wake (>5 min gap) **replays the
full transcript at full price**; stacking that on opus made the Architect the most
expensive agent in the run despite reviewing a 365-line diff.

### 2. Completeness Critic ran tests + crawled the repo — ~8.4M (24%)
A single completeness review burned **5.09M tokens in one run**, tripping the 5M agent
monthly cap mid-run. Root cause from the transcript: the critic
- executed the **full test suite** (`bash scripts/lean-test.sh …`), and
- ran a **repo-wide** `find server/src -name '*.ts' | xargs grep`
during its adversarial pass — both forbidden for a gate reviewer whose job is to read
coverage, not run it. **(Fixed — see remediation.)**

### 3. CTO orchestration on opus — ~7.5M (21%)
15 wakes (plan decompose, delegate, disposition checks) on **opus**. High wake count is
inherent to the orchestrator role; the opus tier multiplied it.

### 4. Structural churn — 14 budget incidents, 11 cancelled runs
The implementor committed to the **wrong branch** (HIVA-20 root branch instead of the
HIVA-21 leaf the gates target), which left the leaf's review chain unable to see the
code. Cancelled/blocked runs and the budget kill-switch firing repeatedly each cost a
replay before being resolved.

---

## Remediation applied this session

| Fix | Commit | Effect |
|---|---|---|
| Completeness Critic: forbid test/build/typecheck/lint execution; ban repo-wide search; cap ~8–12 file reads; opus→sonnet | `bf445360` | Removes the 5M single-run burn mode |
| CTO + Architect kept on opus (decompose/plan quality); implementors + all reviewers on sonnet | `08fc1625` | Caps the 3× tier multiplier to the two roles that need it |
| Registered `completeness-critic` in default-agent instruction routing | `2ac95cb5` | Future critics auto-provision correctly (was a dead gate) |
| Caveman comms rules across all agent prompts | `657f894c` | ~10–20% output-token trim per wake |
| Raised per-run ceiling 500k → 8M; company cap → 20M (live + reset-pilot.sh) | (live) | Stops mid-chain kill-switch trips that force replays |

### Still open (recommended next)
- **Cold-resume replay is the structural cost sink.** Each >5-min wake replays the full
  transcript. Keeping active-task heartbeat intervals under 5 min and resetting agent
  sessions between tasks would cut the Architect/CTO replay tax.
- **Implementor branch-targeting bug.** The implementor committed to the root plan's
  worktree branch, not the leaf's. The leaf gates + PR target the leaf branch — a
  mismatch that required a manual `git cherry-pick` to recover. Worth a wiring fix so
  the implementor's worktree is always the **leaf** issue's branch.
- **Architect success rate.** 2 of 6 Architect runs failed. Each failure on opus is the
  most expensive possible replay. Diagnose the failures before the next pilot.

---

## Gate outcome (for the record)

All six gates approved; leaf `50a420af` → **done**; **PR #3** open + mergeable
(`master` ← `HIVA-21-implement-per-user-upload-rate-limiter`). Root plan `0b4133e4`
remains `in_review` pending the **operator merge** (agents never self-merge).

| Gate | Verdict |
|---|---|
| plan_approval (architect) | approved |
| code_review · scalability | approved |
| code_review · security_authz | approved |
| code_review · test_coverage | approved |
| wiring_review | approved |
| completeness_review | approved |
