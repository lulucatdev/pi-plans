# pi-plans

A text-based project manager for [pi](https://github.com/mariozechner/pi). Plans are living markdown documents with checkbox steps, timestamped logs, and full lifecycle management.

Plans are opt-in. Nothing is injected into the system prompt until you explicitly start and focus a plan. Once focused, the agent automatically tracks progress as it works.

## Installation

```bash
pi install git:github.com/lulucatdev/pi-plans
```

## Commands

| Command | Description |
|---------|-------------|
| `/start-plan [topic]` | Begin a planning session (research, discuss, create) |
| `/plans` | List all plans with status and progress |
| `/focus-plan <path>` | Lock onto a plan (enables automatic tracking) |
| `/unfocus-plan` | Clear focus (stops system prompt injection) |
| `/finish-plan [summary]` | Mark active plan as completed |
| `/abort-plan [reason]` | Abort and archive active plan |
| `/resume-plan <path>` | Restore an archived/paused plan |

## Tools

| Tool | Description |
|------|-------------|
| `plan_create` | Create a new plan with goal and steps, auto-focus |
| `plan_update` | Mark steps complete, add steps, log progress/decisions |
| `plan_finish` | Mark plan completed, optionally archive |
| `plan_abort` | Abort plan with reason, auto-archive |
| `plan_resume` | Reactivate a paused/completed/archived plan |
| `plan_list` | List plans with status filter |
| `plan_focus` | Set active plan for subsequent operations |

## How it works

```
/start-plan refactor auth system        ← user initiates
  agent researches, asks questions
  agent proposes approach, user discusses
  → plan_create(name, goal, steps)      ← plan file created, auto-focused
                                           system prompt injection begins

  agent implements step 1
  → plan_update(complete_step: 1)       ← step marked done, current advances
  → plan_update(log: "decided on JWT")  ← decision recorded

  agent implements step 2
  → plan_update(complete_step: 2, log: "endpoints done")

  ...all steps done...
  → plan_finish(archive: true)          ← archived, focus cleared, injection stops
```

## Plan file format

Plans are stored at `<project>/.pi/plans/YYYYMMDD-HHmm-<slug>.md`:

```markdown
# Auth Refactor

> Status: **active** | Created: 2026-03-22 17:30

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
