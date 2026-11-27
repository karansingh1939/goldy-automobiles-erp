import { Router } from 'express';
import { createAuthService } from '../auth/auth.routes.js';
import { authenticate, requirePermission } from '../../shared/middleware/auth-middleware.js';
import { respondData } from '../../shared/http/respond.js';
import { MoneyService } from './money.service.js';
import { AccountingPostingEngine } from './posting-engine.service.js';
import { AccountingReportService } from './accounting-report.service.js';
import { AllocationService } from './allocation.service.js';
import { CustomerReceiptService } from './customer-receipt.service.js';
import { DirectBillingService } from './direct-billing.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SupplierPaymentService } from './supplier-payment.service.js';
import { WorkshopFinanceService } from './workshop-finance.service.js';

// Single-company app: every accounting call works on company 1.
const COMPANY = 1;

export function createAccountingRouter(db) {
  const router = Router();
  const postingEngine = new AccountingPostingEngine(db);
  const reports = new AccountingReportService(db);
  const receipts = new CustomerReceiptService(db);
  const counterBills = new DirectBillingService(db);
  const reconciliation = new ReconciliationService(db);
  const supplierPayments = new SupplierPaymentService(db, postingEngine, new AllocationService(db));
  const workshopFinance = new WorkshopFinanceService(db);
  const money = new MoneyService(db, { postingEngine });
  const read = requirePermission('accounting.read');
  const write = requirePermission('accounting.write');

  router.use(authenticate(createAuthService(db)));

  // Dues & Daily Cash
  router.get(
    '/receivable-ageing',
    read,
    respondData(() => workshopFinance.ageing()),
  );
  router.get(
    '/daily-cash',
    read,
    respondData((req) => workshopFinance.cashSummary(req.query.date)),
  );
  router.post(
    '/daily-cash',
    write,
    respondData((req) => workshopFinance.saveCount(req.body, req.user.id), 201),
  );

  // Ledgers and vouchers (Accounts screen)
  router.get(
    '/ledgers',
    read,
    respondData(() => reports.listLedgers(COMPANY)),
  );
  router.get(
    '/vouchers',
    read,
    respondData((req) => reports.listVouchers(req.query, COMPANY)),
  );
  router.post(
    '/vouchers',
    write,
    respondData((req) => {
      const { voucherType, voucherDate, narration, entries } = req.body;
      return postingEngine.post({
        companyId: COMPANY,
        voucherType,
        voucherDate,
        narration,
        created_by: req.user.id,
        entries,
      });
    }, 201),
  );

  // Counter Sale bills
  router.get(
    '/direct-invoices',
    read,
    respondData((req) => counterBills.listDirectInvoices(req.query, COMPANY)),
  );
  router.post(
    '/direct-invoices',
    write,
    respondData(
      (req) =>
        counterBills.createDirectInvoice({
          companyId: COMPANY,
          customerId: req.body.customerId || counterBills.walkInCustomerId(),
          invoiceDate: req.body.invoiceDate,
          items: req.body.items,
          narration: req.body.narration,
          createdBy: req.user.id,
        }),
      201,
    ),
  );
  router.get(
    '/direct-invoices/:id',
    read,
    respondData((req) => counterBills.getDirectInvoice(req.params.id, COMPANY)),
  );
  router.post(
    '/direct-invoices/:id/cancel',
    write,
    respondData((req) => counterBills.cancelDirectInvoice(req.params.id, COMPANY, req.user.id)),
  );

  // Customer and supplier payments
  router.post(
    '/receipts',
    write,
    respondData(
      (req) =>
        receipts.createReceipt({
          companyId: COMPANY,
          customerId: req.body.customerId,
          receiptDate: req.body.receiptDate,
          amount: req.body.amount,
          paymentMode: req.body.paymentMode,
          bankLedgerId: req.body.bankLedgerId,
          narration: req.body.narration,
          createdBy: req.user.id,
          autoAllocate: req.body.autoAllocate,
          allocations: req.body.allocations,
        }),
      201,
    ),
  );
  router.post(
    '/payments',
    write,
    respondData(
      (req) => supplierPayments.createPayment(COMPANY, { ...req.body, createdBy: req.user.id }),
      201,
    ),
  );

  // Money In / Out: cash and bank accounts, entries, refunds, opening balances
  router.get(
    '/money-accounts',
    read,
    respondData(() => money.listAccounts()),
  );
  router.post(
    '/money-accounts',
    write,
    respondData((req) => money.addBankAccount(req.body, req.user.id), 201),
  );
  router.patch(
    '/money-accounts/:id',
    write,
    respondData((req) => money.renameBankAccount(req.params.id, req.body, req.user.id)),
  );
  router.get(
    '/money-entries',
    read,
    respondData((req) => money.recentEntries(req.query)),
  );
  router.post(
    '/money-entries',
    write,
    respondData((req) => money.recordOther(req.body, req.user.id), 201),
  );
  router.post(
    '/money-entries/:id/cancel',
    write,
    respondData((req) => money.cancelEntry(Number(req.params.id), req.user.id)),
  );
  router.post(
    '/customer-refunds',
    write,
    respondData((req) => money.refundCustomer(req.body, req.user.id), 201),
  );
  router.post(
    '/opening-balances',
    write,
    respondData((req) => money.recordOpeningBalances(req.body, req.user.id), 201),
  );

  // Reports
  router.get(
    '/reports/trial-balance',
    read,
    respondData((req) => reports.getTrialBalance(COMPANY, req.query.asOfDate)),
  );
  router.get(
    '/reports/profit-loss',
    read,
    respondData((req) => reports.getProfitLoss(COMPANY, req.query.startDate, req.query.endDate)),
  );
  router.get(
    '/reports/balance-sheet',
    read,
    respondData((req) => reports.getBalanceSheet(COMPANY, req.query.asOfDate)),
  );
  // Integrity check of the accounts (admin only)
  router.get(
    '/reports/reconciliation',
    requirePermission('users.manage'),
    respondData(() => reconciliation.runReconciliation(COMPANY)),
  );

  return router;
}
