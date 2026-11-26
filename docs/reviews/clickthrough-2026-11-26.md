# Hands-on click-through — 26 November 2026

The whole app was run on a separate test copy with made-up data (test customers, suppliers, mechanics, banks) and used the way the owner would: every menu screen opened, and every everyday button pressed and its result checked against the accounts. Real workshop data was not touched; the test copy was deleted afterwards.

## What was done, in order

| Area                 | What was tried                                                                                                                        | Result                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| First start          | Create administrator, recovery code, sign in, wrong password, sign out                                                                | Works                                                                   |
| Settings             | Company details, GSTIN state check, Back up now, Restore last backup                                                                  | Works (restore message now shows backup time)                           |
| Mechanics            | Add two, edit, history, deactivate and activate                                                                                       | Works                                                                   |
| Suppliers            | Add, edit, delete with confirm                                                                                                        | Works                                                                   |
| Buy Stock            | Supplier bill with two items, then a second bill with a new price                                                                     | Works after fix (new price is used; average cost 304 checked by hand)   |
| Customers / Vehicles | Add (walk-in and business with GSTIN), search, edit, delete                                                                           | Works after fix (owner name shown)                                      |
| Job cards            | New job card from phone number, mechanic, parts, labour, remove line, print job card, cancel job without bill                         | Works after fixes (mechanic name, total, automatic batch, short number) |
| Bills                | Bill paid in cash, bill on credit, print, part payment, cancel a paid bill                                                            | Works after fix (cancel keeps payment as advance)                       |
| Money In / Out       | Rename bank, add bank, own money in, pay supplier, customer pays part                                                                 | Works after fix (supplier ledger updated)                               |
| Dues & Daily Cash    | Dues, cash count with difference                                                                                                      | Works (plain words, local time)                                         |
| Expenses             | UPI from a bank, cash, edit, delete                                                                                                   | Works; balances checked                                                 |
| Staff & Salary       | Set salary, give advance, pay salary less advance                                                                                     | Works (₹15,000 − ₹2,000 = ₹13,000 handed over)                          |
| Reports & GST        | GSTR-1 files, GSTR-3B, HSN, Tally file, trial balance, P&L, balance sheet                                                             | Works; trial balance and balance sheet balance                          |
| More tools           | Queue, reminders, service history, ledger, day book, sales orders, returns, warranties, stock count, godowns, fixed assets, audit log | Work after fixes (service history, day book, return numbers)            |

## Problems found and fixed

1. **Supplier payments missing from the Supplier Ledger.** Payments made from Money Out reached the accounts but the supplier still showed the full amount owed.
2. **Selling price on a supplier bill was ignored.** Job cards kept charging the old price.
3. **A paid bill could not be cancelled**, and the reason was not shown clearly. Now the stock and sale are reversed and the money paid stays as the customer's advance.
4. **Screens showed old numbers for up to two minutes** after a change elsewhere (Home still showed a cancelled sale).
5. **Service History was blank** after choosing a car, and so was the job card's "Vehicle service history" button.
6. **Mechanic picker showed "undefined"**, and the job card always said "Unassigned".
7. Vehicle list showed "ID: 2" instead of the owner's name.
8. Job cards and credit notes had long timestamp numbers. They are now `JC/26-27/0001` and `CN/26-27/0001` (debit notes `DN/…`). Credit notes are listed in GSTR-1 documents issued, and GSTR-1 dates use the offline tool's `26-Nov-2026` style.
9. Stock report counted 434 never-bought catalogue items as "low stock".
10. Smaller items:
    - plain words on Dues & Daily Cash, Buy Stock, Supplier Ledger, Reports, Stock Count and Home;
    - UTC times shown as local time;
    - US date on the printed job card;
    - an outdated note on Expenses;
    - unlabeled edit and delete buttons;
    - "Karnal," with a stray comma;
    - the batch was not picked automatically;
    - the job card had no running total;
    - cancelled vouchers were not marked in the Day Book;
    - there was no warning when cash went below zero.

## Still worth knowing

- The app lets cash go below zero, and now shows a red warning when it does. This is usually a payment entered from the wrong place.
- Customer refunds have no Money Out choice yet. An advance left after cancelling a bill stays on the customer until the next bill or a manual journal.
- The GSTR-1 files should still be checked once by the CA before the first filing.
- Printing on the real printer, and a fresh install on the laptop, still need a person.
