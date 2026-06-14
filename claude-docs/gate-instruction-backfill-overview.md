# Gate-Instruction Backfill — #4 follow-up (shipped) Overview

> Written 2026-06-14. Covers the **backfill** follow-up of fix-backlog #4. The
> create-path fix (`cba094b4`, `gate-agent-instructions-overview.md`) only seeds
> *new* agents; this re-seeds the gate agents that already exist on the generic
> default bundle. Commit: `768092d8`.

---

## Background

The identity-aware seed (`cba094b4`) selects the right bundle at **agent create**.
Agents created before it — including an existing company's Architect / Code
Reviewer / Wiring Expert — were materialized with the generic `default/AGENTS.md`
and keep it (the seed copy runs once, at create). They still run identity-less.

## What shipped

A one-shot, idempotent, **default-dry** backfill that re-seeds only the gate
agents still on the generic default bundle.

- **Pure decision** — `server/src/services/gate-instruction-backfill.ts`
  `decideGateBackfillAction({urlKey, mode, currentEntryContent, defaultEntryContent})`
  → `{action:"reseed", bundleRole}` **iff** the derived urlKey is a gate role
  (`isIdentityRoutableBundleRole`, now exported as the single source of truth),
  the bundle is **managed**, and the current entry is **byte-for-byte** the generic
  default. Otherwise `{action:"skip", reason}`:
  - `not-a-gate-agent` — urlKey null or not architect/code-reviewer/wiring-expert.
  - `not-managed:<mode>` — external/unknown bundle.
  - `entry-missing` — entry unreadable (a broken gate agent — surfaced, not auto-written).
  - `custom-or-already-seeded` — content differs from default (operator edits, or
    already holding the role bundle → idempotent).
- **Script** — `server/scripts/backfill-gate-instructions.ts`, mirroring
  `backfill-guard-policies.ts` (`DATABASE_URL`, per-row log, exit codes). The
  re-seed deletes+rewrites the live instructions dir (`materializeManagedBundle`
  `replaceExisting:true`), so it is **DRY by default — pass `--apply` to write.**
  Persist parity with the create path: clears legacy prompt-template keys before
  `agents.update(adapterConfig)`.

## Why a content-match guard

Re-seeding overwrites live files. The exact-equality check against the generic
default is what makes the destructive op safe: anything an operator customized, or
any agent already correctly role-seeded, has content ≠ default and is skipped.
The guard is the whole safety story; the unit tests pin every branch plus the
real-content invariant (each role entry ≠ the default entry, so reruns are no-ops).

## Flow

```
tsx server/scripts/backfill-gate-instructions.ts [--apply]
  → default = loadDefaultAgentInstructionsBundle("default")["AGENTS.md"]
  → for each agent row:
       urlKey = normalizeAgentUrlKey(name)
       { mode, entryFile } = getBundle(row);  current = readFile(row, entryFile).content ?? null
       decideGateBackfillAction({ urlKey, mode, current, default })
         reseed (only with --apply):
            files = loadDefaultAgentInstructionsBundle(bundleRole)
            materializeManagedBundle(row, files, { replaceExisting:true, entryFile:"AGENTS.md" })
            agents.update(row.id, { adapterConfig })       // legacy prompt keys stripped
         skip: logged (gate-agent skips surfaced with reason)
  → next wake: isManagedBundleEmpty=false, role AGENTS.md fed to the model
```

## How to run (operator)

```
# preview — no writes
DATABASE_URL=<url> tsx server/scripts/backfill-gate-instructions.ts

# apply
DATABASE_URL=<url> tsx server/scripts/backfill-gate-instructions.ts --apply
```

Run when the gate agents are **idle/paused** — the re-seed rm -rf's and rewrites
the live dir, so an in-flight run reading its bundle mid-rewrite could see a
partial state. Review the dry-run output first; investigate any
`skip:entry-missing` gate agent (a broken bundle the script intentionally leaves
for manual repair).

## Verification

- `gate-instruction-backfill.test.ts` (14 with the create-path suite): every
  decider branch + the real-content idempotency invariant.
- Regression: agent-instructions service + routes suites green (13). `tsc` clean.
- Script lives outside the project tsc include and runs via `tsx`, same as
  `backfill-guard-policies.ts`. No DB migration.

## Status

With this, **#4 is fully closed** — new gate agents seed correctly (create-path
fix) and existing ones can be brought current (this backfill). Remaining #4-area
items stay out of scope and independent: auto-provisioning gate agents at company
setup, and skill auto-assignment.
