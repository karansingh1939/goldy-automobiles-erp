# Full review and clean-up — 26–27 November 2026

**Goal:**

- fix everything and make the app fully working;
- check every line of every file: is it needed, what is it for;
- remove what isn't needed and add what's missing;
- test every feature and button again;
- write down the architecture, system design and what every function does.

**Result:** done. All checks pass: 246 backend tests, 80 screen tests, the
desktop smoke run and a full click-through on a separate test copy with
made-up data. Real workshop data was never touched.

## How every line was checked

1. **Unused-code scans** (my own scripts, nothing downloaded):
   - files nobody uses;
   - functions nobody calls;
   - server addresses (API routes) no screen calls.

   These were run again after each removal, until nothing new turned up.

2. **Coverage run.** It marked every server line the tests never run, and
   92.7% of lines are run. I read each untested block in the important files
   (stock, mechanics, warranties, returns, accounts).
3. **The linter** refuses any unused variable or import in every file.
4. **A cross-check for one dangerous pattern:** every place that moves stock
   must also post the accounting entry.
5. **Two full click-throughs** of every screen and button, with the results
   checked against the cash, bank, dues, stock and ledger figures.

## Problems found and fixed (they would have hurt real use)

| #   | Problem                                                                                                                               | Fix                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Moving stock between godowns made it vanish: it left the first godown and only arrived after a "receive" step that no screen offered. | Moves now complete at once.                                              |
| 2   | The bulk opening-count form changed stock without the accounting entry, so the Balance Sheet's stock value was wrong.                 | It now posts entries like single opening stock.                          |
| 3   | Approving a supplier return didn't lower what you owe on the Supplier Ledger.                                                         | Fixed. Payments and returns now both write the ledger.                   |
| 4   | "Paid in cash" while billing paid the customer's oldest unpaid bill, not the new one.                                                 | The payment now pays the bill just made.                                 |
| 5   | A paid counter-sale bill couldn't be cancelled.                                                                                       | It can now; the money stays as the customer's advance.                   |
| 6   | A wrong Money In/Out entry couldn't be undone without the accounts screen.                                                            | Added "Last entries" with Cancel on Money In / Out.                      |
| 7   | There was no way to give an advance back to a customer.                                                                               | Added "I gave money back to a customer" (never more than their advance). |
| 8   | There was no way to sell parts without a job card, even though the server could.                                                      | Added the **Counter Sale** screen (bill, payment, print, cancel).        |
| 9   | There was no way to send parts back to a supplier.                                                                                    | Added "Send parts back to supplier" on Returns.                          |
| 10  | Draft returns couldn't be cancelled, and warranty claims couldn't be rejected.                                                        | Added both buttons.                                                      |
| 11  | An expired warranty was never actually marked expired.                                                                                | Fixed.                                                                   |
| 12  | Opening stock demanded a batch number.                                                                                                | It's optional now ("OPENING").                                           |
| 13  | Purchase orders, warranty claims, counts, moves and adjustments had long timestamp numbers.                                           | Short numbers like WC/26-27/0001.                                        |
| 14  | The test suite sometimes failed with "database is locked".                                                                            | The connection now waits before switching to WAL.                        |

## Removed (about 6,900 lines)

None of these could be reached from any screen, or they were half-built:

- **Sales Orders and quotations.** They could reserve stock but never bill,
  deliver or cancel it. Replaced by Counter Sale. A database update releases
  any stock they held.
- **Stock reservations.** Only Sales Orders used them.
- **Demo mode and "purge demo".** An old demo database is still opened if
  that old setting is on, so nothing is hidden.
- **Loyalty points, referrals and promotions.** Service reminders are kept.
- **Duplicate APIs:**
  - a supplier API inside accounting;
  - a purchase-bill API inside accounting;
  - a purchase-return API inside purchasing.
- **Unused endpoints:**
  - debug endpoints;
  - restore-by-id;
  - autocomplete;
  - unused report endpoints;
  - GST period locks;
  - warehouse permissions (one user, so meaningless);
  - transfer cancel;
  - the two-step godown receive;
  - the ledger statement.

The database tables stay. Migrations are never undone, and old records
remain readable.

## Documents

- [system-design.md](../system-design.md): architecture, start-up and
  shut-down, layers and rules, data design, document numbers, every main flow
  step by step, screens map, security and quality checks.
- [file-reference.md](../file-reference.md): every one of the 216 source
  files with its purpose, every function (about 1,000) and every migration.
  Regenerate it with `npm run docs:reference`.

## Follow-up the same day: the open items

| Item                                                                       | What was done                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed Assets asked for a code, supplier and invoice                        | Migration 049 rebuilds the table. Only name, date and price are needed; the code is made (FA-0001).                                                                                                                  |
| Buying equipment never touched Cash or Bank (found while fixing the above) | "Paid from" Cash / bank / bought earlier now posts to a Workshop Equipment account on the Balance Sheet; Cancel reverses it.                                                                                         |
| Cash could go below zero silently                                          | Payment forms warn before saving, and Home shows a red warning while it is below zero.                                                                                                                               |
| GSTR-1 files did not match the offline tool's import sheets                | Columns now match the sheets. Added B2CL (other-state bills over ₹1 lakh to buyers without GSTIN). Credit notes to local buyers without GSTIN now reduce B2CS instead of going to CDNUR. HSN split into B2B and B2C. |
| Printing untested                                                          | The smoke run prints three layouts to A4 PDF. The job card sheet spilled its signatures onto a second, grey page: fixed. Printed bills are now on white.                                                             |
| Fresh install untested                                                     | The built Windows app (`npm run pack`) passed the full smoke run on a brand-new database, and an upgrade test keeps equipment entered before migration 049.                                                          |

After the follow-up: 249 backend tests and 83 screen tests pass, plus both
smoke runs and a click-through of the new screens on a test copy.

## Still worth knowing

- **Your CA should import one month's GSTR-1 files into the offline tool**
  before the first filing. The columns follow the tool's sheets, but the
  official templates could not be downloaded to compare word for word.
- **Still needs a person:** a page on the real printer, installing the
  setup file on the workshop laptop, and your father using it day to day.
