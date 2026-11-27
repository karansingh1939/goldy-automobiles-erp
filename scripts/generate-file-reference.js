// Generates docs/file-reference.md: every source file, what it is for, and
// every function in it. Purposes are written by hand below; function
// descriptions come from the code's own comments, or from the function name
// when it has no comment. Run with: node scripts/generate-file-reference.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTES } from './file-reference-notes.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// What each file is for, in one line.
const PURPOSE = {
  // ---- Desktop shell
  'src/desktop/main.js':
    'Electron main process: single instance, starts the local API and database, opens the window, offers a USB backup on close and shuts everything down cleanly.',
  'src/desktop/smoke-check.js':
    'End-to-end desktop smoke test run inside Electron with disposable data: setup, counter sale, supplier bill, dashboard and every main screen.',

  // ---- Server entry and wiring
  'src/server/app.js':
    'Builds the Express app: loopback-only guard, security headers, JSON body limit, static screens, every feature router under /api/v1, and the error handlers.',
  'src/server/server.js':
    'Starts the API: database checks and migrations, backup scheduler, HTTP listener on 127.0.0.1; exports startServer() for the desktop shell.',
  'src/server/config/env.js':
    'Reads settings from the environment (port, AppData folder, database file, admin username, session length, log level).',

  // ---- Database
  'src/server/database/backup-lock.js':
    'Lock file that stops two backups or a backup and a restore running at the same time; clears locks left by a crashed process.',
  'src/server/database/backup-service.js':
    'Low-level SQLite backup: copy the live database safely, verify the copy, keep only the newest N automatic backups, daily startup backup.',
  'src/server/database/connection.js':
    'Opens the single SQLite connection (WAL, foreign keys, busy wait), runs integrity checks and automatic recovery, and closes/reopens it for restores.',
  'src/server/database/corruption-recovery-service.js':
    'If the database file is damaged: keep the damaged copy and restore the newest good backup.',
  'src/server/database/db-safety-service.js':
    'Confirms the connection is configured safely (foreign keys on, WAL journal, normal sync).',
  'src/server/database/init.js': 'Command-line helper: run migrations and seeds on a database.',
  'src/server/database/integrity-check-service.js':
    'Runs SQLite integrity_check and reports whether the file is healthy.',
  'src/server/database/migrate.js': 'Command-line helper: run pending migrations.',
  'src/server/database/migration-repository.js':
    'Records which numbered migrations have been applied.',
  'src/server/database/migration-runner.js':
    'Finds the migrations folder and applies pending migrations in order.',
  'src/server/database/migration-service.js':
    'Applies each migration inside a transaction, after a safety backup, and refuses edited or duplicate migration files (checksums).',
  'src/server/database/seed-runner.js':
    'Runs the numbered seed files once each (roles, permissions, warehouses, categories, starter catalogue).',
  'src/server/database/seed.js': 'Command-line helper: run seeds.',
  'src/server/database/seeds/001_core_seed.js':
    'Seeds the company, roles, permissions and the chart of accounts (system ledgers).',
  'src/server/database/seeds/002_inventory_categories_seed.js':
    'Seeds stock categories (spare parts, lubricants, filters ...).',
  'src/server/database/seeds/003_warehouses_seed.js':
    'Seeds the godowns (Main, Oil, Battery, Tyre store).',
  'src/server/database/seeds/004_inventory_starter_seed.js':
    'Loads the starter catalogue of common parts on a new install (not in tests).',

  // ---- Shared server code
  'src/server/shared/errors/app-error.js':
    'Error type with an HTTP status and a code, shown to the owner as a plain message.',
  'src/server/shared/middleware/auth-middleware.js':
    'Checks the sign-in token and the role permissions for each request.',
  'src/server/shared/middleware/error-handler.js':
    'Turns errors into JSON responses (404 for unknown routes, the AppError message otherwise).',
  'src/server/shared/middleware/local-host-guard.js':
    'Refuses requests that do not come to a loopback host name (protects against DNS rebinding).',
  'src/server/shared/utils/document-number.js':
    'Short consecutive numbers per financial year: INV/26-27/0001 (GST Rule 46, max 16 characters) and JC, CS, CN, DN, PO, GRN, WC, SC, MV, ADJ, OPN.',
  'src/server/shared/utils/local-date.js':
    "Today's date in the laptop's own time zone (YYYY-MM-DD).",
  'src/server/shared/utils/logger.js': 'Writes rotating log files with timestamps and levels.',
  'src/server/shared/utils/tokens.js': 'Creates random session tokens and stores only their hash.',

  // ---- Accounting
  'src/server/modules/accounting/accounting-report.service.js':
    'Trial balance, profit and loss and balance sheet from the journal.',
  'src/server/modules/accounting/accounting.routes.js':
    'Accounting API: receivables, daily cash, money accounts and entries, refunds, opening balances, receipts, supplier payments, counter-sale bills, vouchers, ledgers, reports and the admin reconciliation check.',
  'src/server/modules/accounting/allocation.service.js':
    'Matches payments to bills (oldest first or named bills), undoes matches, and releases payments as advance when a bill is cancelled.',
  'src/server/modules/accounting/customer-credit.repository.js':
    "Reads a customer's credit limit and what they owe.",
  'src/server/modules/accounting/customer-credit.service.js':
    'Refuses a credit bill that would take a customer over their credit limit.',
  'src/server/modules/accounting/customer-receipt.service.js':
    'Money received from customers: receipt voucher, matching to bills, cancelling a receipt.',
  'src/server/modules/accounting/direct-billing.service.js':
    'Counter sale bills (CS/26-27/0001): stock out at weighted cost, GST split, sales and cost vouchers, walk-in customer, cancellation with stock back.',
  'src/server/modules/accounting/ledger-resolver.service.js':
    'Finds ledger ids by their fixed system key (cash_in_hand, inventory_stock ...) with a cache.',
  'src/server/modules/accounting/money.service.js':
    'Money In / Out in plain words: cash and banks, other money in/out, customer refunds, last entries with cancel, opening balances from old books.',
  'src/server/modules/accounting/period-lock.service.js':
    'Indian financial years (April-March): creates years as needed and refuses postings into a closed year.',
  'src/server/modules/accounting/posting-engine.service.js':
    'The double-entry engine: every voucher must balance, gets a number and running balances; vouchers are reversed, never deleted; customer and supplier ledgers are created on demand.',
  'src/server/modules/accounting/reconciliation.service.js':
    'Admin check that ledgers, allocations, trial balance, stock and return limits agree, with a repair for running balances.',
  'src/server/modules/accounting/supplier-payment.service.js':
    'Payments to suppliers: payment voucher, Supplier Ledger row, cancelling a payment.',
  'src/server/modules/accounting/voucher-number.service.js':
    'Sequential voucher numbers per type and year (SAL-, PUR-, REC-, PAY-, JRN-).',
  'src/server/modules/accounting/workshop-finance.repository.js':
    'Queries for unpaid bills, customer balances, the cash book and cash counts.',
  'src/server/modules/accounting/workshop-finance.service.js':
    'Dues & Daily Cash: who owes money and for how long, and the daily cash count.',

  // ---- Audit
  'src/server/modules/audit/audit.controller.js': 'Audit Log API handler.',
  'src/server/modules/audit/audit.repository.js':
    'Writes and lists audit records (who changed what, old and new values).',
  'src/server/modules/audit/audit.routes.js': 'Audit Log route (admins).',
  'src/server/modules/audit/audit.service.js': 'Thin service over the audit repository.',
  'src/server/modules/audit/audit.validator.js': 'Validates Audit Log filters.',

  // ---- Auth
  'src/server/modules/auth/auth.controller.js':
    'Sign-in API handlers: first-run setup, login, logout, forgot password, who is signed in.',
  'src/server/modules/auth/auth.repository.js':
    'Users, roles, permissions, sessions and failed-login lockout in the database.',
  'src/server/modules/auth/auth.routes.js': 'Sign-in routes.',
  'src/server/modules/auth/auth.service.js':
    'Creates the first administrator with a recovery code, checks passwords (bcrypt), locks after repeated failures, issues and revokes sessions.',

  // ---- Backup
  'src/server/modules/backup/backup.controller.js':
    'Backup API handlers: health, back up now, list, verify, schedule settings, restore latest or from a file.',
  'src/server/modules/backup/backup.repository.js':
    'Backup log and schedule settings in the database.',
  'src/server/modules/backup/backup.routes.js': 'Backup routes (administrators).',
  'src/server/modules/backup/backup.scheduler.js':
    'Daily/weekly/hourly automatic backups, catch-up after the laptop was off, retries and error recording.',
  'src/server/modules/backup/backup.service.js':
    'Manual and automatic backups, copy to an external/USB folder, verification, retention and the health warnings shown on Home.',
  'src/server/modules/backup/maintenance-middleware.js':
    'Allows maintenance routes for administrators only.',
  'src/server/modules/backup/snapshot-verification.js':
    'Opens a backup copy on its own and checks it would restore (integrity and migrations).',

  // ---- CRM (service reminders)
  'src/server/modules/crm/crm.controller.js': 'Service reminder API handlers.',
  'src/server/modules/crm/crm.repository.js': 'Service reminders in the database.',
  'src/server/modules/crm/crm.routes.js': 'Service reminder routes.',
  'src/server/modules/crm/crm.service.js':
    'Schedules, lists and dismisses service reminders for a car.',

  // ---- Dashboard
  'src/server/modules/dashboard/dashboard.controller.js': 'Home screen API handlers.',
  'src/server/modules/dashboard/dashboard.repository.js':
    'Queries for cars in the workshop, sales totals, recent bills, top services and stock value.',
  'src/server/modules/dashboard/dashboard.routes.js': 'Home screen routes.',
  'src/server/modules/dashboard/dashboard.service.js':
    'Home screen numbers: sales today/month, profit after expenses, what customers owe, cars in the workshop, stock value and low stock.',

  // ---- Expenses
  'src/server/modules/expenses/expense.controller.js': 'Expenses API handlers.',
  'src/server/modules/expenses/expense.repository.js':
    'Expenses in the database, with filters and totals.',
  'src/server/modules/expenses/expense.routes.js': 'Expenses routes.',
  'src/server/modules/expenses/expense.service.js':
    'Records, edits and deletes expenses with a payment voucher from cash or the chosen bank.',
  'src/server/modules/expenses/expense.validator.js': 'Validates expense entries and list filters.',

  // ---- GST
  'src/server/modules/gst/gst.controller.js': 'GST report API handlers.',
  'src/server/modules/gst/gst.repository.js':
    'GST queries: outward supplies by line, credit notes, input tax, HSN/SAC totals.',
  'src/server/modules/gst/gst.routes.js':
    'GST routes: summary, GSTR-1, GSTR-3B, HSN and the GSTR-1 CSV files.',
  'src/server/modules/gst/gst.service.js':
    'Period handling and shaping of GST summary, GSTR-1, GSTR-3B and HSN reports.',
  'src/server/modules/gst/gstr1-export.service.js':
    'GSTR-1 files for the CA in the GST offline tool layout: B2B, B2C small, credit notes, HSN and documents issued.',

  // ---- Inventory
  'src/server/modules/inventory/inventory.controller.js': 'Stock API handlers.',
  'src/server/modules/inventory/inventory.repository.js':
    'Stock queries: items, batches, movements, adjustments, transfers, counts, fixed assets, low stock.',
  'src/server/modules/inventory/inventory.routes.js': 'Stock routes.',
  'src/server/modules/inventory/inventory.service.js':
    'The stock engine: items, batches, stock in/out with weighted average cost, opening stock, adjustments with accounting, godown moves, counts with approval, valuation, reports, fixed assets, starter catalogue and bulk counts.',
  'src/server/modules/inventory/starter-catalog.js':
    'The starter list of common workshop parts loaded on a new install.',

  // ---- Job cards
  'src/server/modules/job-cards/job-card.controller.js': 'Job card and workshop bill API handlers.',
  'src/server/modules/job-cards/job-card.repository.js':
    'Job cards, their parts and labour, invoices and profit records in the database.',
  'src/server/modules/job-cards/job-card.routes.js': 'Job card, bill and vehicle-intake routes.',
  'src/server/modules/job-cards/job-card.service.js':
    'Job cards from intake to bill: find or create customer and car, add/remove parts and labour, make the GST bill (INV/26-27/0001) with stock out and vouchers, cancel a job or a bill (stock back, payment kept as advance).',

  // ---- Masters
  'src/server/modules/masters/master.config.js':
    'Field rules for the simple record types: customers, suppliers, vehicles, godowns, categories.',
  'src/server/modules/masters/master.controller.js':
    'Generic list/get/create/update/delete handlers.',
  'src/server/modules/masters/master.repository.js':
    'Generic queries for master records (bills and vehicles add customer names).',
  'src/server/modules/masters/master.routes.js': 'Registers a router for each master record type.',
  'src/server/modules/masters/master.service.js':
    'Validates master records and links between them.',
  'src/server/modules/masters/master.validator.js': 'Field validation for master records.',

  // ---- Profit
  'src/server/modules/profit/profit.controller.js': 'Tally export handler.',
  'src/server/modules/profit/profit.repository.js':
    'Profit queries (sales, cost, expenses, by customer) and vouchers for the Tally file.',
  'src/server/modules/profit/profit.routes.js': 'Tally export route.',
  'src/server/modules/profit/profit.service.js':
    'Profit summary and best customers for Home, and the Tally Prime XML export.',

  // ---- Purchasing
  'src/server/modules/purchasing/purchasing.controller.js': 'Buy Stock API handlers.',
  'src/server/modules/purchasing/purchasing.repository.js':
    'Purchase orders, supplier bills (receipts), their lines and the supplier ledger in the database.',
  'src/server/modules/purchasing/purchasing.routes.js': 'Buy Stock and Supplier Ledger routes.',
  'src/server/modules/purchasing/purchasing.service.js':
    'Purchase orders and supplier bills: stock in at cost, new selling price, input GST and purchase voucher, Supplier Ledger row.',
  'src/server/modules/purchasing/supplier-ledger.js':
    'Adds a Supplier Ledger row (bill, payment or return) with the running amount owed.',

  // ---- Restore
  'src/server/modules/restore/restore.service.js':
    'Restores a backup safely: checks it is a Goldy database, keeps a pre-restore copy, swaps files and audits the restore.',

  // ---- Returns
  'src/server/modules/returns/returns.controller.js': 'Returns API handlers.',
  'src/server/modules/returns/returns.repository.js':
    'Customer and supplier returns and their lines in the database.',
  'src/server/modules/returns/returns.routes.js': 'Returns routes.',
  'src/server/modules/returns/returns.service.js':
    'Customer returns (credit note CN/..: stock back if good, GST and profit reversed) and supplier returns (debit note DN/..: stock out, supplier owed less).',

  // ---- Service history
  'src/server/modules/service-history/service-history.controller.js':
    'Service history API handler.',
  'src/server/modules/service-history/service-history.repository.js':
    'Queries for a car, its owner, visits and what was done on each.',
  'src/server/modules/service-history/service-history.routes.js': 'Service history route.',
  'src/server/modules/service-history/service-history.service.js':
    "Builds a car's full service history with totals.",

  // ---- Settings
  'src/server/modules/settings/company-settings.js':
    'Company details printed on bills (name, address, phones, GSTIN, state and terms), GST state codes and GSTIN checks.',

  // ---- Staff pay
  'src/server/modules/staff-pay/staff-pay.routes.js': 'Staff & Salary routes.',
  'src/server/modules/staff-pay/staff-pay.service.js':
    'Monthly salary, advances and salary payment with advance recovery, posted to the accounts.',

  // ---- Technicians
  'src/server/modules/technicians/technician.controller.js': 'Mechanics API handlers.',
  'src/server/modules/technicians/technician.repository.js':
    'Mechanics, job assignments and work history in the database.',
  'src/server/modules/technicians/technician.routes.js': 'Mechanics routes.',
  'src/server/modules/technicians/technician.service.js':
    'Adds, edits, switches off and assigns mechanics; history and job counts.',

  // ---- Warranties
  'src/server/modules/warranties/warranty.controller.js': 'Warranty API handlers.',
  'src/server/modules/warranties/warranty.repository.js':
    'Warranty registrations and claims in the database.',
  'src/server/modules/warranties/warranty.routes.js': 'Warranty routes.',
  'src/server/modules/warranties/warranty.service.js':
    'Registers warranties for parts sold, files claims, settles them (replacement or refund) or rejects them.',

  // ---- Workshop queue
  'src/server/modules/workshop/workshop.repository.js':
    'Queries for open jobs, estimates, approvals, delivery dates and mechanic time.',
  'src/server/modules/workshop/workshop.routes.js': 'Workshop queue routes.',
  'src/server/modules/workshop/workshop.service.js':
    'Workshop queue: estimates, customer approval, promised delivery and mechanic start/stop timers.',

  // ---- Renderer shell
  'src/renderer/App.jsx': 'Screen routes (hash router) behind the sign-in check.',
  'src/renderer/index.css': 'Tailwind setup, colours, larger base text for the owner, print size.',
  'src/renderer/index.html': 'The single HTML page that loads the React app.',
  'src/renderer/main.jsx': 'Starts React with the shared query client.',

  // ---- Renderer screens
  'src/renderer/modules/accounting/AccountingPortal.jsx':
    'Accounts (Ledger): trial balance, profit and loss, day book and manual vouchers.',
  'src/renderer/modules/accounting/MoneyInOut.jsx':
    'Money In / Out: balances, banks, plain money in/out choices, refunds, last entries with cancel, starting balances.',
  'src/renderer/modules/accounting/WorkshopFinance.jsx':
    'Dues & Daily Cash: who owes money and the cash count.',
  'src/renderer/modules/audit/AuditLogManager.jsx': 'Audit Log: every change, who and when.',
  'src/renderer/modules/auth/Login.jsx':
    'First-run administrator setup, sign in and forgot password.',
  'src/renderer/modules/billing/InvoiceManager.jsx':
    'Bills: list with paid/unpaid, the printable tax invoice, cancel a bill.',
  'src/renderer/modules/billing/InvoiceTaxSummary.jsx':
    'Tax breakdown table (CGST/SGST or IGST per rate) on bills.',
  'src/renderer/modules/billing/amount-in-words.js':
    'Indian amount in words (lakh, crore, paise) for bills.',
  'src/renderer/modules/customers/CustomerManager.jsx': 'Customers: search, add, edit, delete.',
  'src/renderer/modules/dashboard/SalesDashboardContainer.jsx':
    'Home: today at the workshop, shortcuts, key numbers, needs attention, best customers, latest bills.',
  'src/renderer/modules/dashboard/components/BackupHealthBanner.jsx':
    'Home banner: is the data backed up, with Back up now.',
  'src/renderer/modules/dashboard/components/DateFilterHeader.jsx':
    'Home title with the date picker and refresh.',
  'src/renderer/modules/dashboard/components/KpiCard.jsx': 'One number card on Home.',
  'src/renderer/modules/dashboard/components/RecentSalesTable.jsx': 'Latest bills table on Home.',
  'src/renderer/modules/dashboard/components/TopCustomersCard.jsx': 'Best customers chart on Home.',
  'src/renderer/modules/dashboard/components/TopServicesCard.jsx':
    'Most common jobs chart on Home.',
  'src/renderer/modules/dashboard/hooks/use-sales-dashboard.js':
    'Loads the Home sales numbers for the chosen date.',
  'src/renderer/modules/dashboard/services/dashboard-api.js': 'Calls the Home sales API.',
  'src/renderer/modules/expenses/ExpenseManager.jsx':
    'Expenses: record, edit, delete, filter and totals.',
  'src/renderer/modules/expenses/expense-description.js':
    'Reads payment details written into older expense descriptions.',
  'src/renderer/modules/inventory/BulkInitialCounts.jsx':
    'Stock: type starting counts for many items at once.',
  'src/renderer/modules/inventory/BulkStockVerification.jsx': 'Stock count for a whole godown.',
  'src/renderer/modules/inventory/FixedAssetManager.jsx':
    'Fixed assets: workshop equipment register.',
  'src/renderer/modules/inventory/InventoryCatalog.jsx': 'Stock list with search and Edit.',
  'src/renderer/modules/inventory/InventoryItemForm.jsx': 'Add or edit a stock item.',
  'src/renderer/modules/inventory/InventoryManager.jsx': 'Stock screen tabs.',
  'src/renderer/modules/inventory/InventoryReports.jsx':
    'Stock reports: summary, valuation, low stock, movements.',
  'src/renderer/modules/inventory/StockOperations.jsx':
    'Move or adjust stock: opening stock, adjustment, godown move, bulk counts.',
  'src/renderer/modules/inventory/StockVerificationManager.jsx':
    'Stock count: count, approve or reject, history.',
  'src/renderer/modules/inventory/inventory-ui.jsx':
    'Shared stock screen parts: fields, selectors, plain column names, list with paging.',
  'src/renderer/modules/job-cards/JobCardCharges.jsx':
    'Parts, lubricants, labour and outside jobs on a job card, with the running total.',
  'src/renderer/modules/job-cards/JobCardIntake.jsx':
    'New job card form: customer, car, complaint, things in the car, mechanic.',
  'src/renderer/modules/job-cards/JobCardManager.jsx':
    'Job Cards: list, detail, add parts and labour, make the bill with payment, print, cancel.',
  'src/renderer/modules/job-cards/use-intake-lookup.js':
    'Finds an existing customer by phone and a car by number while the job card is typed.',
  'src/renderer/modules/masters/MasterManager.jsx':
    'Godowns & Masters: simple records and the starter catalogue.',
  'src/renderer/modules/masters/master-resources.js': 'Field lists for each master record type.',
  'src/renderer/modules/purchasing/PurchaseReceiptDetails.jsx': 'One supplier bill with its lines.',
  'src/renderer/modules/purchasing/PurchaseReceiptForm.jsx':
    'Enter supplier bill: lines, cost, selling price, GST.',
  'src/renderer/modules/purchasing/PurchasingManager.jsx':
    'Buy Stock: supplier bills and optional orders.',
  'src/renderer/modules/reports/GstDetailReports.jsx': 'GSTR-3B and HSN/SAC detail tables.',
  'src/renderer/modules/reports/Gstr1Downloads.jsx': 'Download the five GSTR-1 files for the CA.',
  'src/renderer/modules/reports/ReportsManager.jsx':
    'Reports & GST: tax summary, Tally file, trial balance, P&L, balance sheet, print.',
  'src/renderer/modules/returns/ReturnsManager.jsx':
    'Returns: customer and supplier returns, approve or cancel drafts.',
  'src/renderer/modules/returns/SupplierReturnForm.jsx':
    'Send parts back to a supplier from a supplier bill.',
  'src/renderer/modules/sales/CounterSale.jsx':
    'Counter Sale: sell parts without a job card, payment, print and cancel.',
  'src/renderer/modules/settings/BackupSchedule.jsx': 'Automatic backup schedule settings.',
  'src/renderer/modules/settings/BackupUpload.jsx': 'Restore from a chosen backup file.',
  'src/renderer/modules/settings/CompanyProfileForm.jsx': 'Company details printed on bills.',
  'src/renderer/modules/settings/SettingsPortal.jsx':
    'Settings & Backup: company, back up now, restore, USB folder, schedule.',
  'src/renderer/modules/staff/StaffPay.jsx':
    'Staff & Salary: monthly salary, advances, pay salary.',
  'src/renderer/modules/suppliers/SupplierLedger.jsx':
    'Supplier Ledger: bills, payments, returns and amount still owed.',
  'src/renderer/modules/suppliers/SupplierManager.jsx': 'Suppliers: search, add, edit, delete.',
  'src/renderer/modules/vehicles/ServiceHistory.jsx': 'Service History: everything done on a car.',
  'src/renderer/modules/vehicles/VehicleManager.jsx':
    'Vehicles: search by number or owner, add, edit, delete.',
  'src/renderer/modules/warranties/WarrantyManager.jsx':
    'Warranties: registrations, file, settle or reject claims.',
  'src/renderer/modules/workshop/MechanicTimePanel.jsx': 'Start/stop a mechanic timer on a job.',
  'src/renderer/modules/workshop/ServiceReminders.jsx': 'Service reminders: schedule and dismiss.',
  'src/renderer/modules/workshop/TechnicianHistory.jsx': "A mechanic's jobs and counts.",
  'src/renderer/modules/workshop/TechnicianManager.jsx':
    'Mechanics: add, edit, switch off/on, assign, history.',
  'src/renderer/modules/workshop/WorkshopBoard.jsx':
    'Workshop queue: open jobs, estimates, approval, delivery date.',

  // ---- Renderer shared
  'src/renderer/shared/api/api-client.js':
    'Sends every request with the sign-in token and turns errors into plain messages.',
  'src/renderer/shared/api/inventory-cache.js': 'Refreshes stock lists after any stock change.',
  'src/renderer/shared/api/query-client.js':
    'Data loading settings: always fresh when a screen opens, errors shown as notices.',
  'src/renderer/shared/components/BaseChart.jsx': 'Chart.js wrapper used on Home.',
  'src/renderer/shared/components/DataTable.jsx':
    'Sortable table with paging and empty/error states.',
  'src/renderer/shared/components/Layout.jsx':
    'Menu, More tools, Find a screen (Ctrl+P), F-key shortcuts, notices and confirm dialogs.',
  'src/renderer/shared/components/RemoteSelect.jsx':
    'Search-as-you-type dropdown for customers, items, suppliers and more.',
  'src/renderer/shared/components/ServerPagination.jsx': 'Previous/next page buttons.',
  'src/renderer/shared/hooks/use-permissions.js':
    "Checks the signed-in person's permissions (administrators can do everything).",
  'src/renderer/shared/store/use-app-store.js':
    'App state: sign-in, theme, notices and confirm dialogs.',
  'src/renderer/shared/utils/date-time.js': 'Shows database (UTC) times in local time.',
  'src/renderer/shared/utils/export-csv.js': 'Builds and downloads CSV files.',
  'src/renderer/shared/utils/validation.js':
    'Form checks: required, email, phone, GSTIN, car number.',

  // ---- Public (printable job card)
  'public/local-date.js': "Today's date in local time, shared by the screens and the print page.",
  'public/print-job-card.html': 'Printable job card page (layout and print styles).',
  'public/print-job-card.js':
    'Fills the printable job card from the API and prints or saves it as PDF.',

  // ---- Scripts
  'scripts/benchmark.js': 'Speed test with a large synthetic database.',
  'scripts/check-repo-safety.js':
    'Refuses to let data, backups, .env files or secret keys into the public repository.',
  'scripts/desktop-smoke.js': 'Runs the desktop smoke test in Electron with disposable data.',
  'scripts/generate-file-reference.js': 'Writes docs/file-reference.md (this list).',
  'scripts/file-reference-notes.js':
    'Hand-written descriptions of core business functions used in docs/file-reference.md.',
  'scripts/run-electron-node.js':
    "Runs a script with Electron's Node so SQLite uses the desktop build.",
  'scripts/start-desktop.js': 'Starts the desktop app for development.',
  'scripts/test-server.js':
    'Runs the backend tests in Electron with an isolated folder and database.',
  'scripts/verify-native-runtime.js':
    'Checks the SQLite native module loads in the shipped runtime.',
};

const SECTIONS = [
  ['Desktop shell', 'src/desktop/'],
  [
    'Server: entry, config and shared code',
    /^src\/server\/(app|server)\.js|^src\/server\/(config|shared)\//,
  ],
  ['Server: database', 'src/server/database/'],
  ['Server: feature modules', 'src/server/modules/'],
  ['Screens (React)', 'src/renderer/'],
  ['Printable job card', 'public/'],
  ['Scripts', 'scripts/'],
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(jsx?|html|css|sql)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const clean = (text) =>
  text
    .trim()
    .replace(/^\/\*\*?|\*\/$/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*\*\s?/, '')
        .replace(/^\s*\/\/\s?/, '')
        .trim(),
    )
    .filter((line) => line && !line.startsWith('@') && !/^-+$/.test(line))
    .join(' ')
    .trim();
const humanize = (name) => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1) + '.';
};
const fnPattern =
  /((?:\/\*\*[\s\S]*?\*\/\s*|(?:\/\/[^\n]*\n\s*)+)?)(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s+([A-Za-z_]\w*)|class\s+([A-Za-z_]\w*)|const\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|^ {2}(?:async\s+)?([A-Za-z_]\w*)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*=>|\(.*\)\s*\{\s*$|\(\s*\{?\s*$))/gm;
const SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor']);

function functionsOf(source) {
  const seen = new Set();
  const list = [];
  for (const match of source.matchAll(fnPattern)) {
    const name = match[2] || match[3] || match[4] || match[5];
    if (!name || SKIP.has(name) || seen.has(name)) continue;
    seen.add(name);
    const doc = match[1] ? clean(match[1]).replace(/\s+/g, ' ') : '';
    list.push({ name, kind: match[3] ? 'class' : 'fn', doc: doc.slice(0, 200) });
  }
  return list;
}

const files = ['src', 'public', 'scripts']
  .flatMap((dir) => walk(path.join(root, dir)))
  .map((full) => path.relative(root, full).split(path.sep).join('/'))
  .sort();
const code = files.filter((file) => !file.endsWith('.sql'));
const migrations = files.filter((file) => file.endsWith('.sql'));
const missing = code.filter((file) => !PURPOSE[file]);
if (missing.length) {
  console.error(`No purpose written for:\n  ${missing.join('\n  ')}`);
  process.exitCode = 1;
}

let md = `# File reference

Every source file in the app, what it is for, and every function in it.
Generated by \`npm run docs:reference\` — run it again after
adding or removing files. Function descriptions come from the code's own
comments; where a function has none, its name is spelled out (the names say
what they do, e.g. \`createReceipt\` creates a receipt).

For how the parts fit together, see [system-design.md](system-design.md).

`;
const used = new Set();
for (const [title, match] of SECTIONS) {
  const inSection = code.filter(
    (file) =>
      !used.has(file) && (typeof match === 'string' ? file.startsWith(match) : match.test(file)),
  );
  if (!inSection.length) continue;
  md += `## ${title}\n\n`;
  for (const file of inSection) {
    used.add(file);
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = source.split('\n').length;
    md += `### \`${file}\` (${lines} lines)\n\n${PURPOSE[file] || ''}\n\n`;
    const fns = /\.(jsx?)$/.test(file) ? functionsOf(source) : [];
    for (const fn of fns) {
      const note = NOTES[`${file}#${fn.name}`];
      md += `- \`${fn.name}\`${fn.kind === 'class' ? ' (class)' : ''} — ${note || fn.doc || humanize(fn.name)}\n`;
    }
    if (fns.length) md += '\n';
  }
}
md += `## Database migrations\n\nApplied once each, in order, at start-up (\`src/server/database/migrations\`). Never edit an applied migration; add a new one.\n\n`;
for (const file of migrations) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const head = source.match(/^((?:--[^\n]*\n)+)/);
  const name = path.basename(file, '.sql').replace(/^\d+_/, '').replace(/_/g, ' ');
  const note = head ? head[1].replace(/--\s?/g, ' ').replace(/\s+/g, ' ').trim() : '';
  md += `- \`${path.basename(file)}\` — ${note || name.charAt(0).toUpperCase() + name.slice(1) + '.'}\n`;
}
fs.writeFileSync(path.join(root, 'docs', 'file-reference.md'), md);
console.log(`Wrote docs/file-reference.md: ${code.length} files, ${migrations.length} migrations.`);
