// One-line descriptions for core business functions that have no comment in
// the code. Used by scripts/generate-file-reference.js (key: "file#function").
const S = 'src/server/modules/';

export const NOTES = {
  'src/server/shared/utils/document-number.js#nextDocumentNumber':
    "Reserves the next number in a series for the date's financial year, inside the caller's transaction (a rollback frees it).",

  // Accounting
  [`${S}accounting/allocation.service.js#allocateReceiptFIFO`]:
    'Uses a customer receipt to pay their oldest unpaid bills first.',
  [`${S}accounting/allocation.service.js#allocateReceiptManual`]:
    'Uses a customer receipt to pay the bills named by the caller.',
  [`${S}accounting/allocation.service.js#cancelReceiptAllocations`]:
    'Unmatches a receipt from every bill it paid.',
  [`${S}accounting/allocation.service.js#getOutstanding`]:
    'Unpaid bills of a customer (job card and counter bills) or of a supplier, oldest first.',
  [`${S}accounting/allocation.service.js#allocateFIFO`]:
    'Matches a payment to the oldest unpaid bills of the party.',
  [`${S}accounting/allocation.service.js#allocateManual`]:
    'Matches a payment to named bills, in its own transaction.',
  [`${S}accounting/allocation.service.js#allocateManualTransaction`]:
    "Matches a payment to named bills; refuses more than the unused amount or a cancelled bill, and updates each bill's paid amount and status.",
  [`${S}accounting/allocation.service.js#cancelAllocations`]:
    'Unmatches a payment from all its bills and puts their paid amounts back.',
  [`${S}accounting/allocation.service.js#invoiceNetTotal`]:
    'Bill total minus completed customer returns.',
  [`${S}accounting/allocation.service.js#reconcileInvoiceCredits`]:
    'After a return, frees any payment that is now more than the reduced bill.',
  [`${S}accounting/customer-credit.service.js#assertCustomerCreditLimit`]:
    'Refuses a credit bill that would take the customer past their credit limit.',
  [`${S}accounting/customer-receipt.service.js#createReceipt`]:
    'Records money received from a customer (cash or bank), posts the receipt voucher and pays named bills or the oldest ones.',
  [`${S}accounting/customer-receipt.service.js#cancelReceipt`]:
    'Cancels a receipt: unmatches it from bills and reverses its voucher.',
  [`${S}accounting/direct-billing.service.js#deductStock`]:
    'Takes counter-sale stock out of the godown batch by batch and returns its weighted cost.',
  [`${S}accounting/direct-billing.service.js#createDirectInvoice`]:
    'Makes a counter-sale bill: number, stock out, GST split (CGST/SGST or IGST), credit limit check, sales and cost-of-goods vouchers.',
  [`${S}accounting/direct-billing.service.js#cancelDirectInvoice`]:
    "Cancels a counter bill: stock back to its batches, vouchers reversed, any payment kept as the customer's advance.",
  [`${S}accounting/money.service.js#listAccounts`]:
    'Cash in hand and every bank account with its current balance.',
  [`${S}accounting/money.service.js#accountById`]: 'Finds one cash or bank account, or refuses.',
  [`${S}accounting/money.service.js#addBankAccount`]:
    "Adds the owner's bank account as a new bank ledger.",
  [`${S}accounting/money.service.js#renameBankAccount`]: 'Renames a bank account (audited).',
  [`${S}accounting/money.service.js#recordOther`]:
    "Money in or out that is not a bill: owner's money, loans, other income, other expense.",
  [`${S}accounting/money.service.js#ledgerForKey`]:
    'Finds a system ledger, creating Loans, Other Income or Staff Advances on first use.',
  [`${S}accounting/money.service.js#insertLedger`]:
    'Creates a ledger with its running balance row.',
  [`${S}accounting/money.service.js#recordOpeningBalances`]:
    "Posts starting balances from old books (cash, banks, customer and supplier dues) against the owner's capital.",
  [`${S}accounting/period-lock.service.js#verifyPeriodLock`]:
    'Refuses a posting dated in a closed financial year.',
  [`${S}accounting/period-lock.service.js#ensureFinancialYear`]:
    'Creates financial years up to the one containing the date.',
  [`${S}accounting/posting-engine.service.js#post`]:
    'Posts a balanced voucher: checks the period, the voucher-type rules and that debits equal credits, numbers it and updates running balances.',
  [`${S}accounting/posting-engine.service.js#deleteVoucher`]:
    'Cancels a voucher by posting its reverse and marking it cancelled; nothing is deleted.',
  [`${S}accounting/posting-engine.service.js#validateBalance`]:
    'Debits must equal credits and every amount must be positive.',
  [`${S}accounting/posting-engine.service.js#validateVoucherTypeRules`]:
    'Receipt, payment and contra vouchers must touch cash or bank in the right direction.',
  [`${S}accounting/posting-engine.service.js#updateRunningBalance`]:
    "Keeps each ledger's running balance current.",
  [`${S}accounting/posting-engine.service.js#getOrCreateCustomerLedger`]:
    "The customer's own ledger, created on first use.",
  [`${S}accounting/posting-engine.service.js#getOrCreateSupplierLedger`]:
    "The supplier's own ledger, created on first use.",
  [`${S}accounting/supplier-payment.service.js#createPayment`]:
    'Pays a supplier from cash or bank: payment voucher, Supplier Ledger row, matching to bills.',
  [`${S}accounting/supplier-payment.service.js#cancelPayment`]:
    'Cancels a supplier payment: voucher reversed, matches undone, Supplier Ledger amount added back.',
  [`${S}accounting/supplier-payment.service.js#recordSupplierLedger`]:
    'Adds the payment, or its cancellation, to the Supplier Ledger.',
  [`${S}accounting/workshop-finance.service.js#ageing`]:
    "Unpaid bills grouped by days unpaid, and each customer's balance or advance.",
  [`${S}accounting/workshop-finance.service.js#saveCount`]:
    'Saves a cash count with the book balance at that moment; no accounting change.',

  // Sign-in
  [`${S}auth/auth.service.js#setupAdmin`]:
    'Creates the first administrator and a one-time recovery code.',
  [`${S}auth/auth.service.js#login`]:
    'Checks the password, locks the account for 15 minutes after repeated failures and issues a session token.',
  [`${S}auth/auth.service.js#forgotPassword`]:
    'Resets the password with the recovery code and issues a new code.',
  [`${S}auth/auth.service.js#logout`]: 'Revokes the session.',
  [`${S}auth/auth.service.js#getUserByToken`]:
    'Finds the signed-in user and their permissions for a token.',
  [`${S}auth/auth.service.js#validatePasswordComplexity`]:
    'At least 8 characters with upper and lower case letters and a number.',

  // Backup and restore
  [`${S}backup/backup.service.js#backupDatabase`]:
    'Makes a backup copy, verifies it, logs it and copies it to the external folder if one is set.',
  [`${S}backup/backup.service.js#copyToExternalDestination`]:
    'Copies a backup to the USB or external folder.',
  [`${S}backup/backup.service.js#verifyBackup`]: 'Opens a backup copy and checks it would restore.',
  [`${S}backup/backup.service.js#enforceRetentionPolicy`]:
    'Deletes the oldest automatic backups beyond the number to keep.',
  [`${S}restore/restore.service.js#restoreDatabase`]:
    'Restores a backup: checks it, keeps a pre-restore copy, swaps the files, reopens and audits.',
  [`${S}restore/restore.service.js#verifySchema`]:
    'Refuses a file that is not a complete Goldy database.',

  // Home
  [`${S}dashboard/dashboard.service.js#getOperationsMetrics`]:
    'Cars in the workshop and job card counts for the day.',
  [`${S}dashboard/dashboard.service.js#getFinancialMetrics`]:
    'Sales today and this month, profit after expenses, and what customers owe.',
  [`${S}dashboard/dashboard.service.js#getSalesMetrics`]:
    'Bill counts, best customers, most common jobs and latest bills.',
  [`${S}dashboard/dashboard.service.js#getInventoryMetrics`]:
    'Stock value, item counts and low stock.',

  // Expenses
  [`${S}expenses/expense.service.js#create`]: 'Records an expense and posts its payment voucher.',
  [`${S}expenses/expense.service.js#postExpense`]:
    'Posts the expense voucher: expense account against cash or the chosen bank.',
  [`${S}expenses/expense.service.js#update`]:
    'Edits an expense: the old voucher is reversed and a new one posted.',
  [`${S}expenses/expense.service.js#delete`]: 'Deletes an expense and reverses its voucher.',
  [`${S}expenses/expense.service.js#cancelExpensePosting`]: 'Reverses an expense voucher.',

  // GST
  [`${S}gst/gst.service.js#summary`]: 'Output GST totals (taxable, CGST, SGST, IGST) for a period.',
  [`${S}gst/gst.service.js#hsnSummary`]: 'Quantity, taxable value and tax per HSN/SAC code.',

  // Stock
  [`${S}inventory/inventory.service.js#createItem`]:
    'Adds a stock item (code, name, prices, GST, reorder level, warranty months).',
  [`${S}inventory/inventory.service.js#updateItem`]: 'Edits a stock item (audited).',
  [`${S}inventory/inventory.service.js#createOpeningStock`]:
    'Adds starting stock with its value and posts it to the accounts.',
  [`${S}inventory/inventory.service.js#createAdjustment`]:
    'Adds or removes stock (damaged, lost, expired, correction) and posts the value change.',
  [`${S}inventory/inventory.service.js#transferStock`]:
    'Moves stock from one godown to another at once; the value does not change.',
  [`${S}inventory/inventory.service.js#stockIn`]:
    'Puts stock into a batch and recalculates the weighted average cost.',
  [`${S}inventory/inventory.service.js#stockOut`]:
    'Takes stock out of a batch at the average cost; refuses more than is on hand.',
  [`${S}inventory/inventory.service.js#stockValuation`]:
    'Stock value by average cost, FIFO, batch, or as on a past date.',
  [`${S}inventory/inventory.service.js#seedStarter`]:
    'Loads the starter catalogue of common parts once.',
  [`${S}inventory/inventory.service.js#createFixedAsset`]:
    'Registers workshop equipment separately from stock for sale.',
  [`${S}inventory/inventory.service.js#verifyStock`]:
    'Records a stock count as waiting for approval.',
  [`${S}inventory/inventory.service.js#approveVerification`]:
    'Approves a count and posts the difference as an adjustment.',
  [`${S}inventory/inventory.service.js#rejectVerification`]:
    'Rejects a count without changing stock.',
  [`${S}inventory/inventory.service.js#bulkSave`]:
    'Applies starting counts for many items through opening stock and adjustments in the main godown.',
  [`${S}inventory/inventory.service.js#generateSequentialSku`]: 'Next free ITM-#### item code.',

  // Job cards and bills
  [`${S}job-cards/job-card.service.js#create`]:
    'Opens a job card (JC/26-27/0001) for a customer and car, with odometer and checklist.',
  [`${S}job-cards/job-card.service.js#addPart`]:
    'Adds a part from a batch with price and GST; stock is taken only when billed.',
  [`${S}job-cards/job-card.service.js#addLabour`]:
    'Adds labour or an outside job with its charge and GST.',
  [`${S}job-cards/job-card.service.js#removeLine`]:
    'Removes a wrong part or labour line from an open job card.',
  [`${S}job-cards/job-card.service.js#cancelJobCard`]:
    'Cancels an open job card without a bill (a reason is required).',
  [`${S}job-cards/job-card.service.js#finalize`]:
    'Makes the GST bill (INV/26-27/0001): stock out, GST split, profit record, sales and cost vouchers, warranties.',
  [`${S}job-cards/job-card.service.js#getInvoice`]:
    'A bill with its lines and the odometer reading.',
  [`${S}job-cards/job-card.service.js#cancelInvoice`]:
    'Cancels a bill: stock back, vouchers and profit reversed, payment kept as advance, job card cancelled.',
  [`${S}job-cards/job-card.service.js#calculateInvoiceTotals`]:
    'Revenue, cost, GST and profit totals of the bill lines.',

  // Profit
  [`${S}profit/profit.service.js#summary`]:
    'Sales, cost, gross profit, expenses and net profit for a period (feeds Home).',
  [`${S}profit/profit.service.js#byCustomer`]:
    'Sales and profit per customer (best customers on Home).',
  [`${S}profit/profit.service.js#tallyExport`]:
    'Tally Prime XML with every voucher in the period, for the CA.',

  // Buy Stock
  [`${S}purchasing/purchasing.service.js#createOrder`]:
    'Saves a purchase order (optional; stock and accounts do not change).',
  [`${S}purchasing/purchasing.service.js#createReceipt`]:
    'Enters a supplier bill: stock in per line, purchase voucher with input GST, Supplier Ledger row, order marked received.',
  [`${S}purchasing/purchasing.service.js#validateItems`]:
    'Checks each bill line (item, godown, quantity, cost, price, GST).',
  [`${S}purchasing/purchasing.service.js#applyNewSellingPrice`]:
    'A new selling price typed on a supplier bill becomes the item price (audited).',
  [`${S}purchasing/purchasing.service.js#createPurchaseItems`]:
    'Saves bill lines, puts their stock in and returns the bill totals.',
  [`${S}purchasing/purchasing.service.js#getSupplierLedger`]:
    'Supplier Ledger rows with readable bill, payment and return numbers.',
  [`${S}purchasing/supplier-ledger.js#recordSupplierLedgerEntry`]:
    'Adds a Supplier Ledger row and returns the new amount owed.',

  // Returns
  [`${S}returns/returns.service.js#createCustomerReturn`]:
    'Drafts a customer return (credit note CN/..) for parts on a bill, never more than sold.',
  [`${S}returns/returns.service.js#completeCustomerReturn`]:
    'Approves it: good parts back to stock, damaged written off, GST and profit reversed, credit note voucher.',
  [`${S}returns/returns.service.js#cancelCustomerReturn`]: 'Cancels a draft customer return.',
  [`${S}returns/returns.service.js#createSupplierReturn`]:
    'Drafts a return to a supplier (debit note DN/..) from a supplier bill line.',
  [`${S}returns/returns.service.js#completeSupplierReturn`]:
    'Approves it: stock out, input GST reversed, debit note voucher, Supplier Ledger lowered.',
  [`${S}returns/returns.service.js#cancelSupplierReturn`]: 'Cancels a draft supplier return.',

  // Staff
  [`${S}staff-pay/staff-pay.service.js#summary`]:
    "Each staff member's salary, advance due and whether this month is paid.",
  [`${S}staff-pay/staff-pay.service.js#setMonthlySalary`]: "Sets a staff member's monthly salary.",
  [`${S}staff-pay/staff-pay.service.js#giveAdvance`]:
    'Gives an advance from cash or bank (posted to Staff Advances).',
  [`${S}staff-pay/staff-pay.service.js#paySalary`]:
    "Pays a month's salary once, cutting part of the advance if chosen.",

  // Warranties
  [`${S}warranties/warranty.service.js#registerWarranty`]:
    'Starts a warranty for a part sold; the end date comes from its warranty months.',
  [`${S}warranties/warranty.service.js#fileClaim`]:
    'Files a claim on an active warranty; an expired one is marked expired and refused.',
  [`${S}warranties/warranty.service.js#settleClaim`]:
    'Approves a claim: a replacement part from stock (warranty expense) or a refund.',
  [`${S}warranties/warranty.service.js#rejectClaim`]: 'Rejects a claim.',

  // Workshop queue
  [`${S}workshop/workshop.service.js#queue`]:
    'Open jobs sorted by promised delivery, with estimate and approval state.',
  [`${S}workshop/workshop.service.js#startTimer`]:
    "Starts a mechanic's timer on a job (one at a time).",
  [`${S}workshop/workshop.service.js#stopTimer`]: 'Stops the timer and records the minutes.',
  [`${S}workshop/workshop.service.js#delivery`]: 'Sets the promised delivery time.',
  [`${S}workshop/workshop.service.js#requestEstimate`]: 'Records an estimate sent to the customer.',
  [`${S}workshop/workshop.service.js#decide`]:
    "Records the customer's approval or refusal of the estimate.",
};
