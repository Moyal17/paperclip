# Agent Instructions Architecture — how an agent gets its "brain"

> Written 2026-06-14. Ground-truth map of how Paperclip materializes an agent's
> instruction bundle at creation, the three locations that look like "the
> instructions" (and which one the model actually reads), and the gap that left
> dev-team **gate agents** (architect / code-reviewer / wiring-expert) running on a
> generic identity. Closes the scoping question for fix-backlog **#4**. Source:
> recon of `agent-instructions.ts`, `default-agent-instructions.ts`,
> `routes/agents.ts`, `plan-gates.ts`, `.agents/dev-team/install.py`.

---

## TL;DR

- An agent's runtime "brain" = its **managed instructions bundle** — files on disk
  (`AGENTS.md` is the entry file) that the adapter feeds the model **first, every run**.
- At agent create, the platform **copies a seed bundle** out of a checked-in template
  library (`server/src/onboarding-assets/{role}/`) into the agent's private live dir.
- The template library only has rich content for **`ceo`**. Every other role —
  including the three gate roles — falls back to a single generic `default/AGENTS.md`.
- So gate agents are **competent but amnesiac**: they have their skills, but their
  identity doc never says "you are the Architect, here is the gate protocol." That is
  why dev_team gates behave like rubber-stamps.
- **The wrinkle:** the seed selector keys on `agent.role`, but gate identity is carried
  by `urlKey`/slug, not role (architect & wiring-expert are both `role: "engineer"`).
  Fixing #4 means making the selector **urlKey/slug-aware**, not just adding role folders.

---

## Two brain systems (`agent-instructions.ts:7-14`)

| System | Key | State |
|---|---|---|
| **Managed bundle** | `instructionsBundleMode: "managed"` → files on disk | current |
| **`promptTemplate`** | inline prompt string on the agent record | `@deprecated` (legacy) |

`isManagedBundleEmpty(agent)` (the W1 readiness gate input) returns *empty* only when:
managed mode **and** no files on disk **and** no legacy `promptTemplate`. A generic
`default/AGENTS.md` counts as a file — so an agent seeded with the generic bundle is
**not** paused by W1; it just runs on a blank identity.

## Skills ≠ instructions

Skills (`code-review`, `dev-roles`, `paperclip-dev`, …) are **tools an agent can reach
for**. `AGENTS.md` is **who the agent is** + how it operates. The dev-team gate agents
got the right skills (`COMPANY.md` skills table) but a generic `AGENTS.md`. Capability
without identity = the rubber-stamp failure mode.

---

## Three locations that all look like "the instructions"

```
1. server/src/onboarding-assets/{role}/        ← TEMPLATE / SEED (checked into repo)
        │  copied ONCE at agent create
        ▼
2. $PAPERCLIP_INSTANCE_ROOT/companies/{co}/agents/{agentId}/instructions/   ← LIVE brain
        │  read by the adapter EVERY run
        ▼
   model receives AGENTS.md (+ HEARTBEAT/SOUL/TOOLS if present) as system instructions

3. .agents/dev-team/agents/{role}/AGENTS.md    ← operator-local, GITIGNORED (.gitignore:49)
        hand-authored role docs — meant to be the seed, but live outside the template
        library, so provisioning never reads them. Orphaned content.
```

| Path | Role | Tracked |
|---|---|---|
| `onboarding-assets/{role}/` | template/seed, copied at create | repo |
| `…/agents/{id}/instructions/` | live running brain, editable post-create | operator instance |
| `.agents/dev-team/agents/{role}/AGENTS.md` | intended role docs, wrong place | gitignored |

---

## Materialization flow at create

```
POST /companies/:id/agents                                  routes/agents.ts:2248
   → materializeDefaultInstructionsBundleForNewAgent()      routes/agents.ts:2315
        → resolveDefaultAgentInstructionsBundleRole(role)   default-agent-instructions.ts:25
               role === "ceo" ? "ceo" : "default"           ← THE GAP
        → loadDefaultAgentInstructionsBundle(seedRole)      reads onboarding-assets/{seedRole}/
        → instructions.materializeManagedBundle(agent,…)    writes files to live dir
        → applyBundleConfig(): instructionsBundleMode="managed", root/entry/file paths set
```

Template library today (`default-agent-instructions.ts:4-5`):

```
DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],                            // every non-ceo role
  ceo:     ["AGENTS.md","HEARTBEAT.md","SOUL.md","TOOLS.md"],
}
```

---

## Why your gate agents are generic (not a creation-path mistake)

The dev-team was installed by `.agents/dev-team/install.py` → POST `/companies/:id/agents`
— the **same route** every creation uses; going "through the CEO" would not change this.
`install.py` sends each agent's `cap` (one-line blurb) + `skills`, but **no
`instructionsBundle`**. So the route fell back to the default materializer → generic
`default/AGENTS.md`. The rich `.agents/dev-team/agents/*/AGENTS.md` you authored were
never uploaded.

Two independently-true facts:
1. The **template library** has no gate-role bundles (platform gap).
2. The **installer** never uploaded the orphaned operator-local docs (provisioning gap).

---

## The role-vs-urlKey wrinkle (decides the fix shape)

`resolveDefaultAgentInstructionsBundleRole(role)` keys on **`agent.role`**. But in
`install.py` the gate agents' `role` is generic:

| Agent | slug / urlKey | `role` |
|---|---|---|
| Architect | `architect` | `engineer` |
| Code Reviewer | `code-reviewer` | `qa` |
| Wiring Expert | `wiring-expert` | `engineer` |

Architect and Wiring Expert share `role: "engineer"` — so **a role-keyed selector cannot
give them different seeds.** The gate identity lives in `urlKey`/slug, which is also what
`plan-gates.ts:20-24` (`GATE_DESIGNATED_URL_KEY`) routes gates on:

```
planApproval → "architect"
codeReview   → "code-reviewer"
wiringReview → "wiring-expert"
```

---

## Decision — fix (a): make the seed selector urlKey/slug-aware

Make the platform itself role/identity-aware so **any** future gate agent seeds with the
correct identity, regardless of operator installer.

- Add gate-role seed bundles under `onboarding-assets/architect|code-reviewer|wiring-expert/`
  (rich `AGENTS.md` encoding identity + gate protocol; sourced from the orphaned
  `.agents/dev-team/agents/*/AGENTS.md`, de-fork-specific'd to generic).
- Extend the seed selector to resolve by **urlKey/slug first**, falling back to `role`,
  then `default`. So `urlKey:"architect"` → architect bundle even when `role:"engineer"`.
- Existing agents created with the generic seed need a **re-materialize/backfill** to pick
  up the new identity (live dir already written; seed copy only runs at create).

**Why (a) over (b) (installer uploads the docs):** (b) fixes only the dev-team installer
and only on the operator's machine; every other path that creates a gate agent stays
broken. (a) makes the platform correct once, for all creators. Cost: touches platform
provisioning (selector + template library + a backfill), so it goes through the dev_team
gate workflow.

### Out of scope (separate concerns, do NOT fold in)
- **Auto-provisioning gate agents** at company setup (no factory creates them today).
- **Skill auto-assignment** (`paperclipSkillSync.desiredSkills` only populates on request).
Both are real but independent of giving an already-created gate agent its identity.

---

## Key file references

| What | File:line |
|---|---|
| Create route | `server/src/routes/agents.ts:2248` |
| Default materialize call | `server/src/routes/agents.ts:2315` |
| Seed selector (the gap) | `server/src/services/default-agent-instructions.ts:25-27` |
| Template file map | `server/src/services/default-agent-instructions.ts:4-6` |
| Managed bundle write | `server/src/services/agent-instructions.ts:703-741` |
| Empty-bundle check (W1 input) | `server/src/services/agent-instructions.ts` `isManagedBundleEmpty` |
| Gate urlKey routing | `server/src/services/plan-gates.ts:20-24` |
| Template library | `server/src/onboarding-assets/{ceo,default}/` |
| Orphaned operator docs | `.agents/dev-team/agents/{architect,code-reviewer,wiring-expert}/AGENTS.md` (gitignored) |
| Dev-team installer | `.agents/dev-team/install.py` |
