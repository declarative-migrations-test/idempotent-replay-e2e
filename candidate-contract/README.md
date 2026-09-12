# DPM server exact-head evidence

This contract distinguishes two different artifacts that GitHub pull-request CI can otherwise blur together:

1. the immutable source branch object pinned in `dpm-server.json`;
2. GitHub's synthetic pull-request merge ref, which combines that old branch with a newer `main`.

The pinned head is checked out by its full 40-character SHA. Formatting, compiler compatibility, unit/contract tests, strict lint, OpenAPI parsing, and a real-process HTTP smoke test run as independent jobs so one early failure cannot hide the remaining evidence.

A green exact-head result is not permission to merge the old branch. Pull request 12 predates substantial changes to the migration engine. Its useful server design must be reconstructed on current `main` in independently reviewable slices:

1. versioned HTTP and OpenAPI interfaces;
2. alias-only database selection and bearer-token authorization;
3. dry-run behavior plus explicit destructive-apply confirmation;
4. body/concurrency bounds, request IDs, and real-process smoke tests.

Integration failures caused by current engine types, compile-time environment assumptions, dependency/MSRV changes, or formatting of the synthetic merge ref belong in the current-main reconstruction. Never resolve them by choosing either history wholesale, rebasing destructively, or force-pushing over the source evidence.
