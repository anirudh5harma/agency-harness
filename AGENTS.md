# Repository guide

Agency is a TypeScript ESM CLI. Production code is under `src/`; deterministic tests
mirror it under `test/`. The real-provider fixture and driver live in `fixtures/` and
`scripts/acceptance/`.

- Graph lifecycle and checkpoint routing: `src/graph/coding-run-graph.ts`
- Pi SDK boundary and planner/executor prompts: `src/coding/pi-coding-runtime.ts`
- Runtime interface and test fake: `src/coding/coding-runtime.ts`
- CLI application, commands, REPL, and rendering: `src/cli/`
- Session/checkpoint/registry state: `src/session/` and `src/persistence/`
- Evaluation metrics: `src/evaluations/`
- Git inspection and local exclusion: `src/repo/`
- Independent command execution and verification: `src/process/`

Preserve the central invariant: Pi may plan, edit, and run focused self-checks, but
Agency measures the actual Git delta and independently verifies the target project.
Never bypass verification, weaken/delete tests to make a change pass, or let Agency
stage, commit, push, or open a PR in a target repository.

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. The normal
suite must be deterministic: mock Pi at `PiSdkBoundary`/session boundaries and never
require a live provider. Only `npm run acceptance:real-pi` may use configured Pi
credentials or the network; do not claim it passed unless it was actually run.

`.devagency/` is runtime-owned, project-local metadata. Keep it out of source changes,
never commit it, and preserve the repo-local Git exclude mechanism rather than adding
it to a target project's shared `.gitignore`.

Keep tool-policy claims truthful: application containment is not an OS/network
sandbox. Do not persist prompts, response text, tool arguments, credentials, or raw
changed-file names in metrics or trajectories.
