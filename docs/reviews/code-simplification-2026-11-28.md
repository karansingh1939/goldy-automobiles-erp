# Code simplification review — 28 November 2026

**Asked for:** check the code from the architecture down to each function and
line: is it needed, can it be shorter and simpler, can a built-in do it? The
app must keep working the same way and must not get slower.

**Result:** 39,170 → 36,152 lines of code (the starter parts catalogue, which
is data, is not counted). Seven bugs found and fixed on the way. All tests,
both smoke runs and a click-through pass, and the benchmark is unchanged
within run-to-run noise (table below).

## How the code was checked

1. **Architecture first.** Every module should follow route → controller →
   service → repository. Three route files ran SQL themselves (accounting,
   job-card lookups, company settings); their queries moved into services.
2. **Repeated code across files.** A scanner hashed every run of six real
   lines in all 227 files and listed blocks that appear more than once. It was
   re-run after each round until only small, harmless repeats remained.
3. **Helpers defined more than once.** Same-named functions in different
   files (for example `money` 13 times, `roundMoney` 9 times).
4. **Hand-written code a built-in can do.** For example `crypto.randomUUID`,
   `Map.groupBy`, `fs.rmSync({ force })`, `mkdirSync({ recursive })`,
   `Intl.NumberFormat`, Express `res.attachment()`, optional chaining calls.
5. **Line-by-line reading** of the files with the most logic (see the list at
   the end), with the tests run after each change.
6. **Imports checked by a script:** every named import must exist in the file
   it comes from (the linter does not check this).

## Bugs found and fixed

| #   | Problem                                                                                                                                                          | Fix                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Registering a car without an odometer reading always failed with "Record violates a database constraint" (blank was sent as empty, the database needs a number). | A blank odometer is saved as 0.                                      |
| 2   | The Stock valuation report offered LIFO, which always gave an error. FIFO and BATCH gave values different from the accounts.                                     | One method, weighted average, the same as the Balance Sheet.         |
| 3   | Next service date on a returning car could be a day early (a job closed before 5:30 am counted as the day before).                                               | Dates are taken on the laptop's calendar.                            |
| 4   | A one-month warranty from 31 January ended on 3 March.                                                                                                           | Month ends are kept (28/29 February).                                |
| 5   | Log files written between midnight and 5:30 am went into the previous day's file; stock valuation "as of" a day had the same 5.5-hour slip.                      | Both use the local day.                                              |
| 6   | `npm run benchmark` was broken: it still used the removed Sales Orders and ledger statement.                                                                     | Repaired; it now also times the Accounts voucher list.               |
| 7   | After database recovery the connection set its busy wait last, the setting that caused "database is locked" before.                                              | One function opens every connection with the same settings in order. |

## What was simplified

- **One response wrapper.** `respond()` / `respondData()` replace 108 copies of
  the same try/catch in controllers and routes. A controller method is now one
  line.
- **Database errors mapped once** in the error handler instead of six copies
  wrapped around service calls.
- **Shared helpers instead of copies:** rounding (22 copies), number parsing,
  required-field checks, page and page size (18 copies), date checks (5
  copies; a typed 31 February is now refused everywhere), report periods (the
  GST and profit copies were identical, including a wrong "GST report" message
  on the profit report), WHERE clauses from optional filters.
- **Ledgers in one place** (`accounting/ledgers.js`): customer and supplier
  ledgers were two near-identical 45-line functions; the "cash or which bank"
  choice was copied in Expenses and Fixed Assets.
- **Job card intake** (`createIntake`): the phone clean-up, customer-by-phone
  query (three copies), customer update (two), customer insert (two) and
  vehicle query now come from `intake-lookup.service.js`; an ownership
  transfer written twice now happens once. 1,128 → 905 lines in the file.
- **Stock adjustments:** the record was built twice (once per direction) and
  then patched with an extra UPDATE; now one record with two small
  batch-picking helpers. `inventory.service.js` 1,775 → 1,463 lines.
- **Startup backups and migrations:** no test-only "mock" path in production
  code, one helper for the backups folder and timestamp, safety check as a
  small table instead of four copied blocks.
- **Screens:** Customers and Suppliers were near copies (492 + 464 lines); they
  are now one `PartyScreen` with two small configs. Vehicles uses the same
  shared form parts. The three screens went from 1,497 to about 650 lines.
  Six copied pop-up frames and five copied Cancel/Save button rows use the
  shared `Modal` and `FormButtons`. Eleven copies of the rupee formatter and
  four copies of the cash/bank accounts query became one each.

## Removed (not reachable or not used)

- GET supplier payments list and the ledger "repair" endpoint (no screen or
  test used them).
- Redirects from old web page addresses (the desktop window has no address
  bar; only the app shell and the printable job card are opened).
- Permissions for removed features (GST locks and exports, roles screen), a
  duplicate Main Store seed, an unused `seedStarter` argument, empty logger
  hooks, a never-used health state, orphaned comments left by earlier removals.
- `status: 'success'` and `message` fields in replies that no screen read.

## Performance (same benchmark, same laptop, previous version vs now)

Two runs of each version, taking turns, on a database with 10,000
customers, 10,000 items, 25,000 counter bills and 10,000 receipts:

| Step                                      | Before (average) | Now (average) |
| ----------------------------------------- | ---------------- | ------------- |
| Post 25,000 counter bills                 | 26.9 s           | 26.6 s        |
| 10,000 receipts paying oldest bills first | 6.9 s            | 6.8 s         |
| Trial balance                             | 163 ms           | 154 ms        |

Single runs vary by up to 7% either way on this laptop, so these are the
same speed.

Two things were changed back to keep the app exactly as before:

- **Rounding.** A more exact rounding (13.505 → 13.51) was tried and reverted:
  it would change figures on half-paise amounts and was slightly slower.
- **Filters in SQL.** Two moved queries were first written with "if empty,
  skip" conditions inside the SQL, which can stop SQLite using the date index;
  they build the query from the filters given, as before.

Faster than before: the stock valuation report reads all movements in one
query instead of one per item; counting stock, loading the starter catalogue
and the role seed prepare each SQL statement once instead of once per item.

## Verification

- 253 backend tests and 83 screen tests pass (`npm run check`).
- Desktop smoke run, including the three print layouts, passes.
- Click-through on a separate test copy with made-up data: customers add and
  edit, suppliers, vehicles register (bug 1 found here), a job card for a
  returning car (customer and vehicle reused, not duplicated), add labour,
  stock valuation report, Accounts voucher form, ledger, voucher and counter
  bill lists, GSTR-1 sections.

## Coverage of the line-by-line reading

Read in full and simplified: `connection.js`, `migration-service.js`,
`migration-runner.js`, `backup-service.js`, `db-safety-service.js`,
`integrity-check-service.js`, `corruption-recovery-service.js`,
`backup-lock.js`, the seeds, `app.js`, `server.js`, `env.js`, all shared
middleware and utilities, all controllers, `accounting.routes.js`,
`job-card.routes.js`, `gst.routes.js`, company settings routes,
`inventory.service.js`, the intake part of `job-card.service.js`,
`money.service.js` ledger code, the posting engine's party ledgers,
`gst.service.js` / `profit.service.js` / `dashboard.service.js` filters, the
Customers, Suppliers and Vehicles screens, Fixed Assets, Stock reports.

Covered by the scanners only (duplicate blocks, repeated helpers, built-in
replacements, unused code, import check) and by the tests: the remaining
services and repositories (returns, purchasing, allocation, reconciliation,
warranties, technicians, auth, backup module) and the larger screens (Job
Cards, Reports, Money In/Out, Counter Sale, Returns, Warranties). The scanner
shows no copied block over 44 lines left. The biggest remaining repeats are
two similar GSTR-1 queries in `gst.repository.js` (about 44 lines), the
customer and supplier return forms in `ReturnsManager.jsx` (38) and the
parts and labour tables of the printed job card (26). They differ in small
ways, so merging them would make each harder to read.
