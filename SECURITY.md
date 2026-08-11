# Security boundary

Agency is for trusted local repositories. It enforces least-privilege tool roles,
repository-relative file access, private metadata protection, one-shot approvals for
sensitive mutations, a strict shell allowlist, and unconditional blocking of Git
publication/mutation from Pi. Planner tools are read-only. Agency independently
measures Git changes and verifies the project.

These controls are not an OS or network sandbox. Approved repository verification
scripts are executable project code and inherit host permissions. Portable Node.js
APIs also cannot eliminate every hostile concurrent filesystem race. Do not run
untrusted repositories or instructions; keep credentials outside repositories and
prompts; inspect `/diff`; prefer `agency --worktree` for working-tree isolation.

Run `agency --policy` for the exact active tool policy. `.devagency/` is private
runtime metadata and must not be committed or manually edited.
