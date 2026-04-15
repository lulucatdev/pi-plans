# pi-plans

A text-based project manager for [pi](https://github.com/mariozechner/pi). Plans are folder-based living documents with steps, append-only logs, and integrated research.

Plans are opt-in. Nothing is injected into the system prompt until you explicitly activate a plan. Draft plans created during `/start-plan` stay pending until you approve them, and unrelated one-shot work should proceed without plan tools.

## Installation

```bash
pi install git:github.com/lulucatdev/pi-plans
```

## Commands

| Command | Description |
|---------|-------------|
| `/just-brainstorm [topic]` | Pure brainstorming: explore ideas through Q&A, no research or plan creation |
| `/start-brainstorm [topic]` | Open-ended brainstorming session (research, explore, optionally create a plan) |
| `/start-plan [topic]` | Begin a planning session (research, brainstorm, create) |
| `/plans` | List all plans with status and progress |
| `/activate-plan <path>` | Activate a pending plan |
| `/deactivate-plan [path]` | Deactivate an active plan (moves to `pending/`) |
| `/finish-plan [summary]` | Mark active plan as completed, move to `done/` |
| `/abort-plan [reason]` | Abort active plan, move to `aborted/` |
| `/resume-plan <path>` | Restore a plan from `pending/`, `done/`, or `aborted/` |

## Tools

| Tool | Description |
|------|-------------|
| `plan_focus` | Bind this session to a specific plan folder. Subsequent tool calls default to it. |
| `plan_research` | Create a research document for non-trivial investigation. Skip it for simple answers or small one-shot edits. |
| `plan_brainstorm` | Ask planning questions via UI dialog after the user has entered a planning or brainstorming flow. |
| `plan_create` | Create a new plan folder with `plan.md` + `log.md`. It activates immediately by default; set `activate: false` to leave it in `pending/`. |
| `plan_execute` | Begin execution with guidelines (verification, debugging, research, pivot policy). |
| `plan_update` | Mark steps complete, add steps. Auto-logs changes to `log.md`. Optional explicit log entry. |
| `plan_log` | Add a log entry to the plan's `log.md`. |
| `plan_review` | Start a code review round. Creates review doc in `reviews/`. Run external reviewer, document findings and responses. |
| `plan_prepare_to_verify` | Present automated results and the manual acceptance checklist, then hand manual verification to the user. |
| `plan_verify` | Record the user's manual verification outcome after `plan_prepare_to_verify`. |
| `plan_finish` | Mark plan completed, move to `done/`. Requires all steps done + verification passed. |
| `plan_abort` | Abort plan with reason, move to `aborted/`. |
| `plan_resume` | Resume a plan from `pending/`, `done/`, or `aborted/` to `active/`. |
| `plan_list` | List plans with status filter (`active`, `pending`, `done`, `aborted`). |
| `plan_activate` | Move a pending plan to `active/`. Multiple plans can be active simultaneously. |

## How it works

```
/start-plan refactor auth system          ← user initiates

  Phase 1: Research
  agent explores codebase + web resources
  → plan_research(topic)                  ← creates research doc, agent writes findings

  Phase 2: Brainstorm
  → plan_brainstorm(question, options)    ← clarifying questions via UI dialogs
  → plan_brainstorm(question, context)    ← propose 2-3 approaches
  agent posts full draft plan in chat     ← detailed title, goal, steps, verification
  → plan_brainstorm(question, options)    ← approve or revise the draft

  Phase 3: Create
  → plan_create(name, goal, steps)        ← plan folder created in active/ by default

  Phase 4: Execute
  → plan_execute()                        ← returns plan + execution guidelines
  agent implements step 1
  → plan_update(complete_step: 1)         ← step done, current advances
  → plan_log(message: "decided on JWT")   ← logged to log.md
  → plan_research(topic)                  ← research doc inside plan folder
  ...all steps done...

  Phase 5: Review
  → plan_review()                         ← creates review doc
  agent runs external reviewer (codex/gemini)
  agent writes findings + responses into review doc

  Phase 6: Verify
  → plan_prepare_to_verify(automated_results) ← user performs manual checks
  → plan_verify(status, feedback?)        ← record user acceptance or requested fixes
  → plan_finish()                         ← moved to done/
```

## Plan folder structure

Plans live under `<project>/.pi/plans/` in subdirectories that represent their status:

```
.pi/plans/
├── active/                                    ← 0+ plans being worked on
│   └── 20260323074203-auth-refactor/
│       ├── plan.md                            ← goal, architecture, steps, verification
│       ├── log.md                             ← append-only operation log
│       ├── research/
│       │   ├── 20260323074510-oauth-flows.md
│       │   └── 20260323075200-jwt-comparison.md
│       └── reviews/
│           └── 20260323100000-round-1.md      ← code review findings + responses
├── pending/                                   ← plans saved for later
├── done/                                      ← completed plans
├── aborted/                                   ← aborted plans
└── research/
    └── _standalone/                           ← research without a plan
```

Directory = status. Moving a folder between directories is a state transition.

### plan.md

```markdown
# Auth Refactor

> Created: 2026-03-23 07:42

**Goal:** Refactor authentication to support OAuth 2.0 with PKCE flow.

**Architecture:** Extract auth logic into standalone module, add PKCE middleware.

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
```

### log.md

```markdown
# Plan Log

> Append-only operation log

**2026-03-23 07:42** -- Plan created.
**2026-03-23 07:45** -- Execution started.
**2026-03-23 08:15** -- Researching: OAuth 2.0 PKCE flow → research/20260323081500-oauth-flows.md
**2026-03-23 09:00** -- Completed step 1. Decided on PKCE for public clients.
```

## Design philosophy

- Plans are folders in the project, not ephemeral session state.
- The agent reads, updates, and references the plan as it works.
- Full observability: the user can see and edit any file at any time.
- No magic: plans are plain markdown, version-controllable, human-editable.
- Research results persist alongside the plan they belong to.
- Logs are append-only — corrections are made by adding new entries.

## License

MIT
