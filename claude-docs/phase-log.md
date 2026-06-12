# Hive Factory — Phase Build Log

Running log of factory build sessions. Each entry: what shipped, gate result,
commits, follow-ups. Plan of record: `~/.claude/plans/i-want-you-to-calm-eagle.md`.

---

## Session 1 — A1 (gate-profile, soft) + E1 (lean runners) — 2026-06-12

**Built through `/dev-roles` full gate workflow. Both review gates APPROVED.**

### A1 — Gate-profile (soft)

A plan can now carry a `gateProfile` of `none` (default) or `dev_team`. When a
`dev_team` plan is activated, Paperclip materializes advisory gate approvals and
routes them to the dev-team agents — without blocking anything (soft / advisory;
hard-block is Phase C1).

What activation creates:
- one `gate_plan_approval` on the plan-root issue → **Architect**
- per materialized leaf: `gate_code_review` → **Code Reviewer**, `gate_wiring_review` → **Wiring Expert**

Each gate is a row in the existing `approvals` table, linked to its issue via
`issue_approvals`, with `payload.designatedAgentId` resolved from company agents
by urlKey (`architect` / `code-reviewer` / `wiring-expert`). A missing/ambiguous
role falls back to the board owner and logs a warning — activation never fails
because a gate role is unstaffed.

The blocked-inbox classifier branches on `gate_*` approval types and surfaces
three new reasons — `pending_plan_approval`, `pending_code_review`,
`pending_wiring_review` — with the designated agent as owner and
**plan > code > wiring** precedence (one attention per issue; the next gate
appears after the prior is decided). Non-gate approvals are byte-for-byte
unchanged (parity test green).

Agents act on gates through a new **agent-only** endpoint
`POST /approvals/:id/agent-decide`. Hard authorization boundary: the actor must
be an agent, the approval must be a `gate_*` type, and the actor must equal
`payload.designatedAgentId`. Board `approve`/`reject` stay board-only. The
decision records `decided_by_agent_id` for the audit trail (feeds the A4 ledger).

UI: `NewPlanDialog` gains an advisory "Enforce dev-team gate protocol" toggle.
Gate reviews with an `approvalId` resolve inline (one-click approve/reject).

**Schema:** migration `0100_gate_profile` adds `plan_details.gate_profile`
(default `'none'`) and `approvals.decided_by_agent_id` (nullable FK,
ON DELETE SET NULL).

### E1 — Lean runners

`scripts/lean-test.sh`, `lean-typecheck.sh`, `lean-lint.sh` (+ `lean-report.mjs`)
run vitest / tsc / eslint but print **only failures** (`file:line · test · first
error lines`) plus a pass/fail tally, hard-capped at `LEAN_MAX_LINES` (default
60). Exit code passes through. Shipped as the vendored `lean-runners` skill with
a rule in all six dev-team `AGENTS.md`: never run raw test/build/lint for a whole
package — use the wrapper. (Dev-team package is gitignored / operator-local; the
wrapper scripts themselves are committed under `scripts/`.)

### Verification
- `pnpm -r typecheck`: clean (db, shared, server, ui).
- Targeted vitest: plan-gates (7), plan-gate-activation embedded-pg (5),
  agent-decide route authz (5), issue-detail-attention parity (green),
  approvals-service + idempotency (green), blockedInbox (22), NewPlanDialog (2).
- Full UI suite: 1325 passed, 1 pre-existing unrelated failure
  (`issueDetailQuery.test` — fails on baseline with our edits stashed).
- Migration chain applies cleanly (exercised by the embedded-pg activation test).

### Gates
- Code Review: APPROVED — 2 LOW notes (activate() gate creation not transactional
  with child materialization — matches existing non-transactional loop, soft so
  harmless; reviewer AGENTS.md don't yet call /agent-decide — deferred to A3).
- Wiring: APPROVED — trace entrypoint→terminal complete; 1 warning (agents not
  yet instructed to call /agent-decide — A3 scope).

### Commits
- `feat(db): add gate_profile + approvals.decided_by_agent_id for dev-team gates`
- `feat(shared): add gate reasons, PlanGateProfile, agent-decide validator`
- `feat(server): materialize and route dev-team gate approvals (soft)`
- `feat(ui): gate-protocol toggle on new plan + gate attention verbs`
- `build(dev-team): add lean test/typecheck/lint runners (E1)`
- `docs: add factory product roadmap and platform vision`

### Carry-forward
- A3: wire reviewer/implementor AGENTS.md to call `/agent-decide` + post findings.
- C1: flip soft → hard-block (enforce on activate/done for agent actors).
- Consider wrapping activate() gate creation + child materialization in one tx
  when C1 makes gates load-bearing.

### Next: A2 — worktree-per-issue auto-provision.
