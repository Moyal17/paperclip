---
name: Development Team
description: Elite engineering department with an enforced plan/code/wiring gate protocol — a CTO orchestrator, an Architect plan gate, parallel Code Reviewer and Wiring Expert gates, and two Implementors. Installs gate-ready, with the dev-roles workflow and review skills vendored in-package.
schema: agentcompanies/v1
slug: dev-team
category: software-development
key: paperclipai/bundled/software-development/dev-team
manager: agents/cto/AGENTS.md
includes:
  - agents/architect/AGENTS.md
  - agents/code-reviewer/AGENTS.md
  - agents/wiring-expert/AGENTS.md
  - agents/implementor-1/AGENTS.md
  - agents/implementor-2/AGENTS.md
  - skills/code-review/SKILL.md
  - skills/context-engineering/SKILL.md
  - skills/debugging-and-error-recovery/SKILL.md
  - skills/incremental-implementation/SKILL.md
  - skills/source-driven-development/SKILL.md
  - skills/dev-roles/SKILL.md
  - skills/task-timing/SKILL.md
defaultInstall: true
recommendedForCompanyTypes:
  - software
  - startup
  - generalist
tags:
  - default
  - engineering
  - gates
  - code-review
  - software-development
---

# Development Team

A self-contained engineering department that recreates the Elite Engineering Team
gate workflow inside a Paperclip company. It boots the smallest org that can take an
engineering request, plan it under an architect gate, build it in thin slices, and
clear it through parallel code-review and wiring gates before it ships.

## Org

```
CTO  (cto, opus)                      orchestrator; owns the gate protocol
├── Architect  (engineer, opus)       plan-approval gate
├── Code Reviewer  (qa, sonnet)       code-review gate   ┐ run in parallel
├── Wiring Expert  (engineer, sonnet) wiring gate        ┘
├── Implementor 1  (engineer, sonnet) full-stack / API
└── Implementor 2  (engineer, sonnet) backend / db / infra
```

## Gate protocol

```
issue → Implementor plan → [Architect approves] → build (thin slices)
      → [Code Reviewer] + [Wiring Expert] both approve → done
      → any reject → fix → only the rejecting reviewer re-reviews
```

No code before plan approval. No `done` while any gate is pending or rejected.

## Skills

The gate workflow (`dev-roles`), review checklist (`code-review`), and the
engineering knowledge skills (`source-driven-development`, `context-engineering`,
`debugging-and-error-recovery`, `incremental-implementation`, `task-timing`) are
vendored in-package under `skills/`. The bundled Paperclip skills (`paperclip`,
`paperclip-dev`, `paperclip-converting-plans-to-tasks`, `paperclip-create-agent`)
are always available to local adapters and are merged in automatically at runtime.

## Note — declarative, not auto-enforced

Paperclip is declarative: it does not hard-enforce the gate sequence the way a
single-context runner does. The protocol lives in each agent's instructions and is
modeled on Paperclip's real approval, review-state, and blocked-inbox mechanics —
strong, but agent-driven.
