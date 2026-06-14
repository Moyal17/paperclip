# New Company + Pilot — Runbook

> Written 2026-06-15. How to spin up a fresh, gate-ready company and run a pilot on
> the `feat/myhive-board` build. A new company now **auto-provisions the dev-team gate
> squad** on create (`gate-team-auto-provision-overview.md`), so there is no manual
> agent setup and no backfill — the squad comes up with identities, skills, and the
> gate org tree already wired.

API base in all examples: `http://127.0.0.1:3100/api` (default port; a busy port
auto-bumps — check the server log line). On a local instance you are an implicit
board/instance-admin, so no auth token is needed.

---

## 0. Prerequisites — run the new code

Auto-provision only fires on `POST /api/companies` in this branch's hook. A server
running an older build will create an **empty** company. So:

```bash
git -C ~/sourceControl/paperclip branch --show-current   # expect feat/myhive-board
export CLAUDE_CODE_TMPDIR=~/.paperclip-tmp && mkdir -p ~/.paperclip-tmp  # #13: roomy tmp
pnpm -C ~/sourceControl/paperclip dev          # server (watch/rebuild)
pnpm -C ~/sourceControl/paperclip dev:ui       # UI, separate terminal (optional)
```

Wait for the server to report its listen port before creating anything.

---

## 1. Create the company

**UI:** Companies page → New Company → name it → create.

**API:**
```bash
curl -s -X POST http://127.0.0.1:3100/api/companies \
  -H 'Content-Type: application/json' \
  -d '{"name":"Hive Pilot"}' | tee /tmp/company.json
COMPANY=$(node -e "console.log(require('/tmp/company.json').id)")
echo "companyId=$COMPANY"
```

On create the hook installs the `dev-team` (the sole `defaultInstall` team). A
provisioning failure is **non-fatal** — the company is still created — so always
verify step 2.

---

## 2. Verify auto-provision (the gate squad)

```bash
curl -s "http://127.0.0.1:3100/api/companies/$COMPANY/agents" \
  | node -e "const a=JSON.parse(require('fs').readFileSync(0));
      console.log(a.map(x=>x.name+' ['+x.role+'] -> '+(x.reportsTo??'ROOT')).join('\n'))"
```

Expect **6 agents** — CTO (ROOT) plus Architect, Code Reviewer, Wiring Expert,
Implementor 1, Implementor 2, all reporting to the CTO. If you see 0 agents: the
server was on an old build, or provisioning errored — check the server log for
`default team auto-provision failed`, fix, and recreate the company.

Spot-check identity (the #4 fix): open the Architect's instructions in the UI — it
should read the **Architect** role doc (plan-approval gate), not a generic stub.

---

## 3. Kick off the pilot

Give the CTO an engineering request as a **plan**, then activate it. The CTO
decomposes it into child issues and drives the gate protocol; activation wakes the
Architect immediately (W5a).

Find the CTO id from step 2's output, then:

```bash
CTO=<cto-agent-id>
curl -s -X POST http://127.0.0.1:3100/api/plans \
  -H 'Content-Type: application/json' \
  -d "{\"companyId\":\"$COMPANY\",
       \"title\":\"Pilot: <your task>\",
       \"overview\":\"<what to build + acceptance criteria>\",
       \"gateProfile\":\"dev_team\",
       \"assigneeAgentId\":\"$CTO\"}" | tee /tmp/plan.json
PLAN=$(node -e "console.log(require('/tmp/plan.json').issue.id)")

# Operator activates → materializes tier-1 child issues + wakes the architect
curl -s -X POST "http://127.0.0.1:3100/api/plans/$PLAN/activate"
```

`gateProfile: "dev_team"` runs the full plan + code + wiring gates. Use `"light"`
(code-review only) or `"solo"` (no gates) for smaller work — the Layer-0 triage floor
still forces full gates on high-risk paths (auth/migrations/routes).

(Or skip plans entirely: create an issue and assign it to the CTO — same orchestration,
no tiered plan.)

---

## 4. Watch the gates actually work

On the MyHive board / via the API, you should see the loop run itself:

1. CTO assigns a child issue to an Implementor and moves it `in_progress` (provisions a
   worktree).
2. Implementor posts a plan → **Architect** is woken, approves/rejects (plan gate).
3. Implementor builds, opens a PR, moves the leaf to `in_review` → **Code Reviewer +
   Wiring Expert** are woken immediately (W5b) and decide their gates.
4. Both approve → leaf `done`. Any reject → fix → only the rejecting reviewer re-reviews.

Latency check: architect should wake within seconds of activation, reviewers within
seconds of `in_review` — not on the hourly timer.

---

## 5. Burn-guard sanity (it can't run away)

The guards are armed by default. To confirm / tune: `GET /api/instance-settings` shows
`guards` (monthly token caps, per-run ceiling, loop breaker). If an agent loops or
blows a cap it auto-pauses with a `budget_incidents` entry and a
`budget_override_required` approval — resume from the incident. Master kill switch:
`guards.enabled = false`.

---

## 6. Retry / clean slate

To start over, just **create another fresh company** (step 1) — it re-provisions
gate-ready. Non-destructive; leave the previous one for comparison.

Only delete a company (`DELETE /api/companies/:id`) if you truly want its board,
issues, and agents gone — it drops the whole subtree and is irreversible. Confirm
before doing it.

---

## Quick reference

| Action | Call |
|---|---|
| Create company (auto-provisions) | `POST /api/companies {name}` |
| List agents | `GET /api/companies/:id/agents` |
| Create plan | `POST /api/plans {companyId,title,overview,gateProfile,assigneeAgentId}` |
| Activate plan (wakes architect) | `POST /api/plans/:planIssueId/activate` |
| Stop a plan | `POST /api/plans/:planIssueId/stop` |
| Guards / incidents | `GET /api/instance-settings` |
| Delete company (destructive) | `DELETE /api/companies/:id` |
