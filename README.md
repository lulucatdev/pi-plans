# pi-plans

A text-based project manager for [pi](https://github.com/mariozechner/pi). Plans are living markdown documents with checkbox steps, timestamped logs, and full lifecycle management.

Plans are opt-in. Nothing is injected into the system prompt until you explicitly start and activate a plan. Once active, the agent automatically tracks progress as it works.

## Installation

```bash
pi install git:github.com/lulucatdev/pi-plans
```

## Commands

| Command | Description |
|---------|-------------|
| `/start-plan [topic]` | Begin a planning session (research, discuss, create) |
| `/plans` | List all plans with status and progress |
| `/activate-plan <path>` | Activate a plan (enables automatic tracking) |
| `/deactivate-plan` | Deactivate the active plan (moves to `pending/`) |
| `/finish-plan [summary]` | Mark active plan as completed, move to `done/` |
| `/abort-plan [reason]` | Abort active plan, move to `done/` |
| `/resume-plan <path>` | Restore a plan from `pending/` or `done/` |

## Tools

| Tool | Description |
|------|-------------|
| `plan_create` | Create a new plan; prompts user to start now, save for later, or give feedback |
| `plan_update` | Mark steps complete, add steps, log progress/decisions |
| `plan_finish` | Mark plan completed, move to `done/` |
| `plan_abort` | Abort plan with reason, move to `done/` |
| `plan_resume` | Move a `pending/` or `done/` plan to `active/` |
| `plan_list` | List plans with status filter (`active`, `pending`, `done`) |
| `plan_activate` | Move a plan to `active/` (parks current active to `pending/`) |

## How it works

```
/start-plan refactor auth system        ← user initiates
  agent researches, asks questions
  agent proposes approach, user discusses
  → plan_create(name, goal, steps)      ← plan saved to pending/
                                           user prompted: start now / save / feedback
  user picks "Start now"                ← moved to active/, system prompt injection begins

  agent implements step 1
  → plan_update(complete_step: 1)       ← step marked done, current advances
  → plan_update(log: "decided on JWT")  ← decision recorded

  agent implements step 2
  → plan_update(complete_step: 2, log: "endpoints done")

  ...all steps done...
  → plan_finish()                       ← moved to done/, injection stops
```

## Plan file format

Plans live under `<project>/.pi/plans/` in subdirectories that represent their status:

```
.pi/plans/
├── active/       ← 0 or 1 plan, the one currently being worked on
├── pending/      ← plans saved for later
└── done/         ← completed or aborted plans
```

Directory = status. No pointer files, no in-file status fields. Moving a file between directories is a state transition.

Example plan at `.pi/plans/active/20260322-1730-auth-refactor.md`:

```markdown
# Auth Refactor

> Created: 2026-03-22 17:30

Refactor authentication to support OAuth 2.0 with PKCE flow.

## Steps

- [x] Research OAuth 2.0 flows
- [x] Design token storage schema
- [ ] **Implement authorization endpoints** ← current
- [ ] Update client-side login flow
- [ ] Add tests

## Log

**2026-03-22 17:30** — Plan created.
**2026-03-22 18:15** — Decided on PKCE for public clients. JWT access, opaque refresh.
**2026-03-22 19:00** — Completed schema. Two tables: tokens, sessions.
```

## Design philosophy

Follows the [pi developer's guidance](https://github.com/mariozechner/pi) on planning:

- Plans are files in the project, not ephemeral session state.
- The agent reads, updates, and references the plan as it works.
- Full observability: the user can see and edit the plan at any time.
- No magic: plans are plain markdown, version-controllable, human-editable.

## License

MIT
