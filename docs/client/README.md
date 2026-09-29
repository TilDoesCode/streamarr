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
| [`orchestrator.js`](./orchestrator.js) | Current orchestration script; relaunch with `args.skip` = finished task ids |
| `runs/` | Mirrored raw workflow journals (git-ignored, diagnostics only) |
| [`env.sh`](./env.sh) | `source` it for dotnet, JDK 17 and Android SDK paths |

## Resuming in a new session

1. Read `PLAN.md`, then `JOURNAL.md`, then every `journal/*.md` whose status is not `done`.
2. A task with `Status: in-progress` was interrupted — its builder continues from the notes
   and the working tree; do not restart it from scratch.
3. Commit a finished-but-uncommitted task by hand (path-scoped, like `commitPrompt` in the
   script), then relaunch `orchestrator.js` via the Workflow tool (`scriptPath`) with
   `args: { skip: [<committed task ids>] }`.
4. Start `mirror-run.sh <transcriptDir> <scriptPath> <runId>` right after launching so the
   run journal survives a crashed session.

The script stops a lane as soon as an agent dies (usage limit, expired token) and never
starts tasks that depend on it. Verification checks the task's acceptance checklist; after
a fix round only the previous blocking findings are re-checked.
