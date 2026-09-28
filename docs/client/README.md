# Streamarr Client — build workspace

Durable home of the client build: spec, progress journal and evidence. Everything here
survives a crashed or ended session (unlike the harness's temporary workflow journal).

| File | Purpose |
|---|---|
| [`plan.html`](./plan.html) | Human plan (German): architecture, player strategy, milestones |
| [`PLAN.md`](./PLAN.md) | Binding agent spec: decisions, conventions, task definitions |
| [`JOURNAL.md`](./JOURNAL.md) | Chronological one-line log of every task outcome |
| `journal/<TASK-ID>.md` | Source of truth per task: status, decisions, evidence, follow-ups |
| `screenshots/<TASK-ID>/` | Visual evidence captured with Argent |
| `runs/` | Mirrored raw workflow journals (git-ignored, diagnostics only) |
| [`env.sh`](./env.sh) | `source` it for dotnet, JDK 17 and Android SDK paths |

## Resuming in a new session

1. Read `PLAN.md`, then `JOURNAL.md`, then every `journal/*.md` whose status is not `done`.
2. A task with `Status: in-progress` was interrupted — continue it from its notes and the
   working tree; do not restart it from scratch.
3. Pick the next tasks in milestone order (see `PLAN.md` §5) and relaunch the
   orchestration with the finished task ids excluded.
