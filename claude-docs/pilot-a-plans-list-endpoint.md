# Pilot A — GET /companies/:id/plans List Endpoint

**Branch:** `pilot/b1-dogfood`
**Commit:** `094a5b57`
**Scope:** `server/src/routes/plans.ts`, `server/src/services/plans.ts`, `server/src/__tests__/plans-list.test.ts`

---

## Background

The HIVA-17 benchmark task: add a way to list all plans for a company. No such endpoint existed. Plans are issues with a `plan_details` sidecar and no parent (`parentIssueId = null`).

This was the actual feature the dev-team pilot agent chain implemented end-to-end during HIVA-17.

---

## What was built

### `planService.listPlans(companyId, { state? })`

New method in `server/src/services/plans.ts`. Joins `issues` ↔ `plan_details`:

- Filters to root issues (`parentIssueId IS NULL`) that have a `plan_details` row
- Optional `state` filter (passed to SQL WHERE)
- Returns `{ issueId, title, state, gateProfile, assigneeAgentId, createdAt }[]` sorted by `createdAt DESC`

### `GET /api/companies/:companyId/plans`

New route in `server/src/routes/plans.ts`:

- Auth: `assertCompanyAccess` (403 on wrong company)
- Query param: `?state=draft|active|done` (validated via `listPlansQuerySchema`)
- Delegates to `planService.listPlans`
- Returns 200 + array (empty array when no plans)

---

## Tests

`server/src/__tests__/plans-list.test.ts` — embedded Postgres, 4 cases:

| Test | Expect |
|---|---|
| No plans for company | 200 `[]` |
| Single draft plan | 200 `[{ state: "draft", ... }]` |
| `?state=active` filter | only active plans returned |
| Wrong company | 403 |

---

## AC (from backlog)

- `GET /api/companies/:id/plans` returns array of `{ issueId, title, state, gateProfile, assigneeAgentId, createdAt }` sorted by createdAt desc
- 200 empty array when no plans
- 403 on wrong company

All AC verified by tests and confirmed by human audit (`claude-docs/myhive-pilot-cost-report-hiva17.md` §4b).

---

## Files Changed

| File | Change |
|---|---|
| `server/src/services/plans.ts` | `listPlans` method (new) |
| `server/src/routes/plans.ts` | `GET /companies/:companyId/plans` route + query schema (new) |
| `server/src/__tests__/plans-list.test.ts` | 4 integration tests (new) |
