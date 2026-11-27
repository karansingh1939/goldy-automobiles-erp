# Full cleanup and review — progress (27 November 2026)

Goal from the owner's son: fix everything, check every line of every file (is it needed, what is it for),
remove what is not needed, add what is missing, re-test every feature and button, then write an
architecture / system design / function reference document.

Rules: code only in the public repo (no data, backups or secrets, `npm run check:safety`), fictional
test data only, never touch the real data in %APPDATA%, commit and push to main after `npm run check`
passes, keep everything simple for a non-technical owner.

| #   | Step                                                                            | Status         |
| --- | ------------------------------------------------------------------------------- | -------------- |
| 1   | Fix known gaps: customer refund, counter sale screen, payment pays its own bill | Done (d98ad84) |
| 2   | Unused-code scan (files, exports, API routes no screen calls)                   | Done           |
| 3   | Remove dead modules: Sales Orders, demo mode, CRM loyalty/referrals/promotions  | Done (d98ad84) |
| 4   | Remove remaining unused API routes and their dead service code                  | Done           |
| 5   | Coverage run; read every file and fix or remove what is not needed              | Done           |
| 6   | Re-test every screen and button on a throwaway test copy                        | Done           |
| 7   | Write docs/system-design.md (architecture, data flow, every file and function)  | Pending        |
| 8   | `npm run check`, smoke test, commit, push, report                               | Pending        |
