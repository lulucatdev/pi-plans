# pi-plans

A text-based project manager for [pi](https://github.com/mariozechner/pi). Plans are living markdown documents with checkbox steps, timestamped logs, and full lifecycle management.

Plans are opt-in. Nothing is injected into the system prompt until you explicitly start and activate a plan. Once active, the agent is prompted to track progress using plan tools as it works.

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
| `/deactivate-plan [path]` | Deactivate an active plan (moves to `pending/`). Path required when multiple active. |
| `/finish-plan [summary]` | Mark active plan as completed, move to `done/` |
| `/abort-plan [reason]` | Abort active plan, move to `done/` |
| `/resume-plan <path>` | Restore a plan from `pending/` or `done/` |

## Tools

| Tool | Description |
|------|-------------|
| `plan_focus` | Bind this session to a specific plan. Subsequent tool calls default to it without needing `plan_path`. |
| `plan_research` | Initiate a research phase at any stage. Logs topic to plan, returns methodology guidance (tasks, exa, web_search). |
| `plan_brainstorm` | Ask the user a question via UI dialog (select or free-text). Used for all interaction before `plan_create`. |
| `plan_create` | Create a new plan; prompts user to start now, save for later, or give feedback |
| `plan_execute` | Begin execution of the active plan with guidelines (verification, debugging, research, pivot policy) |
| `plan_update` | Mark steps complete, add steps, log progress/decisions |
| `plan_verify` | Acceptance phase: present automated test results + manual checklist to user for approval |
| `plan_finish` | Mark plan completed, move to `done/`. Call `plan_verify` first. |
| `plan_abort` | Abort plan with reason, move to `done/` |
| `plan_resume` | Move a `pending/` or `done/` plan to `active/` |
| `plan_list` | List plans with status filter (`active`, `pending`, `done`) |
| `plan_activate` | Move a plan to `active/`. Multiple plans can be active simultaneously. |

## How it works

```
/start-plan refactor auth system          ← user initiates

  Phase 1: Research
  agent explores codebase + web (tasks, exa, web_search)

  Phase 2: Brainstorm
  → plan_brainstorm(question, options)    ← clarifying questions via UI dialogs
  → plan_brainstorm(question, context)    ← propose 2-3 approaches
  → plan_brainstorm(question, options)    ← confirm design

  Phase 3: Create
  → plan_create(name, goal, steps)        ← plan saved to pending/
  user picks "Start now"                  ← moved to active/

  Phase 4: Execute
  → plan_execute()                        ← returns plan + execution guidelines
  agent implements step 1
  → plan_update(complete_step: 1)         ← step done (verified), current advances
  → plan_update(log: "decided on JWT")    ← decision recorded
  ...if stuck, call plan_research(topic)  ← debugging + research methodology
  ...all steps done...

  Phase 5: Verify
  → plan_verify(automated_results)             ← user acceptance
  → plan_finish()                         ← moved to done/
```

## Plan file format

Plans live under `<project>/.pi/plans/` in subdirectories that represent their status:

```
.pi/plans/
├── active/       ← 0+ plans being worked on (multiple agents can work in parallel)
├── pending/      ← plans saved for later
└── done/         ← completed or aborted plans
```

Directory = status. No pointer files, no in-file status fields. Moving a file between directories is a state transition.

Example plan at `.pi/plans/active/20260322-1730-auth-refactor.md`:

```markdown
# Auth Refactor

> Created: 2026-03-22 17:30

**Goal:** Refactor authentication to support OAuth 2.0 with PKCE flow.

**Architecture:** Extract auth logic into standalone module, add PKCE middleware, JWT access tokens with opaque refresh tokens stored in SQLite.

---

## Steps

- [x] Research OAuth 2.0 flows
- [x] Design token storage schema
- [ ] **Implement authorization endpoints** ← current
- [ ] Update client-side login flow
- [ ] Add tests

## Verification

### Automated Checks
- `npm test`
- `npm run build`

### Manual Acceptance
- [ ] OAuth login flow works with Google
- [ ] Token refresh works after expiry
- [ ] Error page renders on auth failure

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
