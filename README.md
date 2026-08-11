# Agency

Agency is a local autonomous coding CLI for Git repositories. Pi plans and edits;
Agency measures the real Git delta, runs project verification independently, repairs
bounded failures, and keeps durable checkpoints and project context.

## Start in five minutes

Requirements: Node.js 22.19+, npm, Git, and a Pi-supported model provider.

```sh
git clone https://github.com/anirudh5harma/agency-harness.git
cd agency-harness
npm install
npm run build
npm link
```

Connect a provider. Recommended for ChatGPT/Codex subscribers:

```sh
npx --no-install pi
```

Inside Pi, run `/login`, choose **OpenAI Codex**, and complete browser login. Pick a
model offered by that account; model availability depends on provider/account, so do
not assume a model such as `gpt-5.6-sol` exists. Exit Pi, then verify auth if useful:

```sh
npx --no-install pi auth check --provider openai-codex
```

API-key providers also work. Start Pi, run `/login`, choose the provider, and enter
the key; or use the provider environment variable from Pi's
[provider guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).
Never store credentials in the target repository.

Start Agency inside any trusted Git repository:

```sh
cd /path/to/project
agency
```

Then type a concrete request:

```text
agency> Add zero-divisor handling and focused tests.
```

Agency streams model text and tool activity, asks for clarification or approval when
needed, edits through repository-contained tools, independently runs detected
`test`, `typecheck`, `lint`, and `build` scripts, and reports the measured Git delta.
It never stages, commits, pushes, or opens a PR in the target repository.

## Main capabilities

- Rich TTY UI with multiline input (end a line with `\`), streaming responses,
  highlighted diffs, live status, Ctrl+L redraw, and collapsible tool activity.
- Human elevation with 2–3 choices, approval/reject/edit actions, or free-form input.
- Durable session compaction and editable project knowledge under
  `.devagency/knowledge/`.
- SQLite run recovery, bounded repair, safe lifecycle trajectories, and numeric run
  evaluations.
- Optional isolated Git worktree via `agency --worktree`; worktrees are preserved
  unless explicitly discarded.
- Git-backed `/checkpoint` and conservative `/undo` that refuse user-diverged paths.
- Bounded missions: tests, dead-code, simplify, and performance.
- Least-privilege planner/executor tool policy. Inspect it with `agency --policy`.

## Commands

| Command | Purpose |
| --- | --- |
| `/help` | Show commands |
| `/status` | Repository, session, and last-run status |
| `/diff` | Current staged, unstaged, and untracked diff |
| `/verify` | Run detected checks without Pi |
| `/compact` | Fold older session context |
| `/mission tests\|dead-code\|simplify\|performance` | Run one bounded objective |
| `/metrics [last]` | Aggregate or latest run metrics |
| `/checkpoint [label]` | Snapshot without changing HEAD or staging |
| `/undo [checkpoint]` | Restore unchanged Agency-owned paths |
| `/worktree [keep\|discard]` | Inspect or manage isolated worktree |
| `/tools` | Collapse/expand tool activity in TTY mode |
| `/policy` | Show enforced permissions and sandbox status |
| `/new` | Start fresh conversational context |
| `/exit` | Exit |

Use `agency --help` for startup options.

## How runs work

One natural-language request creates one bounded LangGraph run:

```text
prepare -> plan -> execute -> verify -> repair (bounded) -> summarize
```

Pi owns provider/model interaction and the inner coding loop. Agency owns Git truth,
verification, sessions, checkpoints, recovery, approvals, metrics, and terminal UI.
Planner tools are read-only. Executor file tools are repository-contained; sensitive
files and consequential commands need exact one-shot approval. Git mutation,
publishing, credential access, arbitrary network/cloud commands, and unsupported
shell composition are blocked.

`.devagency/` contains runtime metadata: session state, SQLite checkpoints, Pi
sessions, trajectories, evaluations, Git checkpoint metadata, and project knowledge.
Agency adds it to the repository-local Git exclude file, not shared `.gitignore`.

## Security boundary

Agency's tool policy is application-level containment, not OS isolation. Approved
project verification scripts execute trusted repository code and may access host
resources available to the Agency process. Use trusted repositories, inspect `/diff`,
and use `agency --worktree` when isolation from your main working tree helps. See
[SECURITY.md](./SECURITY.md).

## Development

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Normal tests are deterministic and use fake Pi boundaries. Real-provider acceptance
uses configured credentials and quota:

```sh
npm run acceptance:real-pi
```

It builds Agency, creates a temporary fixture repository, runs two related natural
turns, validates transcript/diff/status, then reruns fixture tests and typecheck.
