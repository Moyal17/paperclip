# /dev-roles full — Run Summary: GET /api/companies/:companyId/plans

Bench arm: `/dev-roles full` (single-context role-switching). Repo: `paperclip-devroles-bench`, branch `bench/dev-roles-plans`. Date: 2026-06-15.

Task: add a GET endpoint listing a company's plans (root issue + `plan_details` sidecar).

---

## What was built

`GET /api/companies/:companyId/plans` — lists a company's plans, newest-first, optional `?state=` filter.

Files:
- `server/src/services/plans.ts` — `listPlans(companyId, {state?})`: `plan_details INNER JOIN issues` on `issueId`, filtered by `plan_details.companyId` (+ optional `state`), projects `{issueId,title,state,gateProfile,assigneeAgentId,createdAt}`, `ORDER BY issues.createdAt DESC`. Added `desc` to the drizzle import.
- `server/src/routes/plans.ts` — `GET /companies/:companyId/plans` (router mounted prefix-less → resolves to `/api/companies/...`); calls `assertCompanyAccess` first, coerces `?state=` to string, returns the array.
- `server/src/__tests__/company-plans-list-routes.test.ts` — new, embedded-postgres harness.

---

## Acceptance criteria — all met

- Documented projection, newest-first
- `?state=` filters (match + no-match → `[]`)
- Empty company → `200 []`
- Cross-company → `403`

---

## Gate trail

| Role | Verdict | Cycle | Findings |
|---|---|---|---|
| Architect (plan) | APPROVED | 1 | 2 warnings, both folded into build: (a) test must mount `errorHandler` for 403 mapping; (b) `createdAt` must come from `issues`, not `plan_details`. |
| Code Reviewer | APPROVED | 1 | 0 CRITICAL/HIGH/MEDIUM. 1 LOW: `?state=` is unvalidated open string (unknown state → `[]`, not 400) — consistent with existing `plan_details.state` text convention, accepted. |
| Wiring Expert | APPROVED | 1 | 0 findings. Verified no route shadowing by `companyRoutes`, complete `desc` import, 403 surfaced via Express 5 async-rejection → `errorHandler`. |

Both review gates passed cycle 1. No deferred warnings/TODOs.

Wiring trace:
- entrypoint: `server/src/app.ts:227 api.use(planRoutes(...)) -> /api`
- path: `routes/plans.ts:GET /companies/:companyId/plans` → `routes/authz.ts:assertCompanyAccess` → `services/plans.ts:listPlans`
- terminal: `routes/plans.ts: res.json(result)`

---

## Tests

- New test file: green.
- Regression: `plan-draft-no-wake`, `plan-gate-activation`, `plan-gates` — all green.
- No standalone `tsc` in workspace; vitest transpiles via esbuild. Types reasoned manually (explicit `listPlans` return type, no `any`).

---

## Review-quality verdict

Clean implementation, zero blocking findings, one genuine non-blocking observation (unvalidated `state`). Substantive catches landed at the plan gate (projection source-of-truth for `createdAt`, test wiring) — defects prevented before code, not after.

---

## Cost (from CLI `/cost`)

- Billed cost: **$5.45**
- API compute: **8m 14s**
- Wall-clock: **31m 54s**
- Tokens (Opus 4.8): 17.3k input + 25.2k output + **5.4M cache read** + 201.5k cache write
  (≈ 5.64M processed; 95%+ cache reads → cheap)
- Code: 301 lines added, 1 removed
- SP estimate: 2h (1 task)

Head-to-head vs the MyHive `dev_team` pilot (~9.06M tokens, hours, 20 runs) lives in
`myhive-pilot-cost-report-hiva17.md` §6. Bottom line: equal code + equal review quality;
`/dev-roles` shipped more lines for single-digit dollars in 8 min compute vs the pilot's
hours — the agent-company's extra cost bought the control-plane infrastructure (async audit
trail, isolation, parallel reviewers, budget/kill-switch), not better output.
