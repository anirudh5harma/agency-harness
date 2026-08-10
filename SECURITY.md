# Phase 1 security boundary

Agency Phase 1 is not secure isolation. Coding runtimes and verification commands
execute with the same operating-system permissions as the Agency process. The
repository-local `.devagency/` exclusion and redacted trajectory records protect
working-tree hygiene and observability data; they are not a sandbox or command
authorization boundary.

Do not use Phase 1 to run untrusted repositories or instructions. Process
sandboxing and dangerous-command policy enforcement are intentionally deferred.
