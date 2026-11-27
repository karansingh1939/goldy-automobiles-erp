import { MoneyService } from './money.service.js';
import { Router } from 'express';
import { createAuthService } from '../auth/auth.routes.js';
import { authenticate, requirePermission } from '../../shared/middleware/auth-middleware.js';
import { AccountingPostingEngine } from './posting-engine.service.js';
import { AccountingReportService } from './accounting-report.service.js';
import { AllocationService } from './allocation.service.js';
import { CustomerReceiptService } from './customer-receipt.service.js';
import { DirectBillingService } from './direct-billing.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SupplierPaymentService } from './supplier-payment.service.js';
import { WorkshopFinanceService } from './workshop-finance.service.js';

export function createAccountingRouter(db) {
  const router = Router();
  const authService = createAuthService(db);
  const requireAuth = authenticate(authService);

  const postingEngine = new AccountingPostingEngine(db);
  const reportService = new AccountingReportService(db);
  const allocationService = new AllocationService(db);
  const receiptService = new CustomerReceiptService(db);
  const directBillingService = new DirectBillingService(db);
  const reconciliationService = new ReconciliationService(db);
  const supplierPaymentService = new SupplierPaymentService(db, postingEngine, allocationService);

  // Authenticate all routes
  router.use(requireAuth);
  const workshopFinance = new WorkshopFinanceService(db);
  router.get('/receivable-ageing', requirePermission('accounting.read'), (req, res, next) => {
    try {
      res.json({ data: workshopFinance.ageing() });
    } catch (error) {
      next(error);
    }
  });
  router.get('/daily-cash', requirePermission('accounting.read'), (req, res, next) => {
    try {
      res.json({ data: workshopFinance.cashSummary(req.query.date) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/daily-cash', requirePermission('accounting.write'), (req, res, next) => {
    try {
      res.status(201).json({ data: workshopFinance.saveCount(req.body, req.user.id) });
    } catch (error) {
      next(error);
    }
  });

  // --- LEDGER MASTER READ ENDPOINT ---
  router.get('/ledgers', requirePermission('accounting.read'), (req, res, next) => {
    try {
      const companyId = 1; // Default tenant
      const ledgers = db
        .prepare(
          `
        SELECT l.id, l.name, l.group_id, l.opening_balance, l.nature, l.system_key, ag.name AS group_name
        FROM ledgers l
        JOIN account_groups ag ON l.group_id = ag.id
        WHERE l.company_id = ?
        ORDER BY l.name ASC
      `,
        )
        .all(companyId);

      res.status(200).json({
        status: 'success',
        data: ledgers,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- DIRECT BILLING ENDPOINTS ---

  // List direct invoices
  router.get('/direct-invoices', requirePermission('accounting.read'), (req, res, next) => {
    try {
      const companyId = 1;
      const { customerId, status } = req.query;

      let sql = `
        SELECT di.*, c.name AS customer_name
        FROM direct_invoices di
        JOIN customers c ON di.customer_id = c.id
        WHERE di.company_id = ?
      `;
      const params = [companyId];

      if (customerId) {
        sql += ' AND di.customer_id = ?';
        params.push(customerId);
      }
      if (status) {
        sql += ' AND di.status = ?';
        params.push(status);
      }

      sql += ' ORDER BY di.invoice_date DESC, di.id DESC LIMIT 200';

      const invoices = db.prepare(sql).all(...params);
      res.status(200).json({ status: 'success', data: invoices });
    } catch (err) {
      next(err);
    }
  });

  // Create direct invoice
  router.post('/direct-invoices', requirePermission('accounting.write'), (req, res, next) => {
    try {
      const companyId = 1;
      const result = directBillingService.createDirectInvoice({
        companyId,
        customerId: req.body.customerId || directBillingService.walkInCustomerId(),
        invoiceDate: req.body.invoiceDate,
        items: req.body.items,
        narration: req.body.narration,
        createdBy: req.user.id,
      });

      res.status(201).json({
        status: 'success',
        message: 'Direct invoice created successfully.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });

  // Get specific direct invoice
  router.get('/direct-invoices/:id', requirePermission('accounting.read'), (req, res, next) => {
    try {
      const companyId = 1;
      const invoice = db
        .prepare('SELECT * FROM direct_invoices WHERE id = ? AND company_id = ?')
        .get(req.params.id, companyId);
      if (!invoice) {
        return res.status(404).json({ error: { message: 'Direct invoice not found.' } });
      }

      const items = db
        .prepare(
          `
        SELECT dii.*, ii.item_name, ii.sku, ii.hsn_code
        FROM direct_invoice_items dii
        LEFT JOIN inventory_items ii ON dii.item_id = ii.id
        WHERE dii.direct_invoice_id = ?
      `,
        )
        .all(invoice.id);

      res.status(200).json({
        status: 'success',
        data: {
          ...invoice,
          items,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Cancel direct invoice
  router.post(
    '/direct-invoices/:id/cancel',
    requirePermission('accounting.write'),
    (req, res, next) => {
      try {
        const companyId = 1;
        const result = directBillingService.cancelDirectInvoice(
          req.params.id,
          companyId,
          req.user.id,
        );
        res.status(200).json({
          status: 'success',
          message: 'Direct invoice cancelled successfully.',
          data: result,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- CUSTOMER RECEIPTS & ALLOCATION ENDPOINTS ---

  // Record a customer receipt
  router.post('/receipts', requirePermission('accounting.write'), (req, res, next) => {
    try {
      const companyId = 1;
      const result = receiptService.createReceipt({
        companyId,
        customerId: req.body.customerId,
        receiptDate: req.body.receiptDate,
        amount: req.body.amount,
        paymentMode: req.body.paymentMode,
        bankLedgerId: req.body.bankLedgerId,
        narration: req.body.narration,
        createdBy: req.user.id,
        autoAllocate: req.body.autoAllocate,
        allocations: req.body.allocations,
      });

      res.status(201).json({
        status: 'success',
        message: 'Receipt posted successfully.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- MANUAL VOUCHER ENDPOINTS ---

  // List all vouchers with optional filters (startDate, endDate, type, search)
  router.get('/vouchers', requirePermission('accounting.read'), (req, res, next) => {
    try {
      const companyId = 1;
      const { startDate, endDate, type, search } = req.query;

      let sql = 'SELECT * FROM vouchers WHERE company_id = ?';
      const params = [companyId];

      if (startDate) {
        sql += ' AND voucher_date >= ?';
        params.push(startDate);
      }
      if (endDate) {
        sql += ' AND voucher_date <= ?';
        params.push(endDate);
      }
      if (type) {
        sql += ' AND voucher_type = ?';
        params.push(type);
      }
      if (search) {
        sql += ' AND (voucher_number LIKE ? OR narration LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }

      sql += ' ORDER BY voucher_date DESC, id DESC';

      const vouchers = db.prepare(sql).all(...params);

      res.status(200).json({
        status: 'success',
        data: vouchers,
      });
    } catch (err) {
      next(err);
    }
  });

  // Plain-language money screens (cash and bank accounts, money in/out, opening balances)
  const moneyService = new MoneyService(db, { postingEngine });
  const handle = (status, fn) => (req, res, next) => {
    try {
      res.status(status).json({ data: fn(req) });
    } catch (err) {
      next(err);
    }
  };
  router.get(
    '/money-accounts',
    requirePermission('accounting.read'),
    handle(200, () => moneyService.listAccounts()),
  );
  router.post(
    '/money-accounts',
    requirePermission('accounting.write'),
    handle(201, (req) => moneyService.addBankAccount(req.body, req.user.id)),
  );
  router.patch(
    '/money-accounts/:id',
    requirePermission('accounting.write'),
    handle(200, (req) => moneyService.renameBankAccount(req.params.id, req.body, req.user.id)),
  );
  router.post(
    '/money-entries',
    requirePermission('accounting.write'),
    handle(201, (req) => moneyService.recordOther(req.body, req.user.id)),
  );
  router.get(
    '/money-entries',
    requirePermission('accounting.read'),
    handle(200, (req) => moneyService.recentEntries(req.query)),
  );
  router.post(
    '/money-entries/:id/cancel',
    requirePermission('accounting.write'),
    handle(200, (req) => moneyService.cancelEntry(Number(req.params.id), req.user.id)),
  );
  router.post(
    '/customer-refunds',
    requirePermission('accounting.write'),
    handle(201, (req) => moneyService.refundCustomer(req.body, req.user.id)),
  );
  router.post(
    '/opening-balances',
    requirePermission('accounting.write'),
    handle(201, (req) => moneyService.recordOpeningBalances(req.body, req.user.id)),
  );

  // Create a manual voucher (Contra, Receipt, Payment, Journal)
  router.post('/vouchers', requirePermission('accounting.write'), (req, res, next) => {
    try {
      const companyId = 1;
      const { voucherType, voucherDate, narration, entries } = req.body;

      const result = postingEngine.post({
        companyId,
        voucherType,
        voucherDate,
        narration,
        created_by: req.user.id,
        entries,
      });

      res.status(201).json({
        status: 'success',
        message: 'Voucher posted successfully.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- REPORT ENDPOINTS ---

  // Live Trial Balance compilation
  router.get('/reports/trial-balance', requirePermission('accounting.read'), (req, res, next) => {
    try {
      const companyId = 1;
      const { asOfDate } = req.query;

      const report = reportService.getTrialBalance(companyId, asOfDate);
      res.status(200).json({
        status: 'success',
        data: report,
      });
    } catch (err) {
      next(err);
    }
  });

  // Live Profit & Loss statement compilation
  router.get('/reports/profit-loss', requirePermission('accounting.read'), (req, res, next) => {
    try {
      const companyId = 1;
      const { startDate, endDate } = req.query;

      const report = reportService.getProfitLoss(companyId, startDate, endDate);
      res.status(200).json({
        status: 'success',
        data: report,
      });
    } catch (err) {
      next(err);
    }
  });

  // Live Balance Sheet compilation
  router.get('/reports/balance-sheet', requirePermission('accounting.read'), (req, res, next) => {
    try {
      const companyId = 1;
      const { asOfDate } = req.query;

      const report = reportService.getBalanceSheet(companyId, asOfDate);
      res.status(200).json({
        status: 'success',
        data: report,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- SUPPLIER REGISTRY ENDPOINTS ---

  // --- PURCHASING BILL ENDPOINTS ---

  // --- SUPPLIER OUTSTANDING ENDPOINTS ---

  // --- SUPPLIER PAYMENT ENDPOINTS ---

  router.get('/payments', requirePermission('accounting.read'), (req, res, next) => {
    try {
      const payments = supplierPaymentService.listPayments(req.query);
      res.status(200).json({ status: 'success', data: payments });
    } catch (err) {
      next(err);
    }
  });

  router.post('/payments', requirePermission('accounting.write'), (req, res, next) => {
    try {
      const companyId = 1;
      const payload = { ...req.body, createdBy: req.user.id };
      const payment = supplierPaymentService.createPayment(companyId, payload);
      res.status(201).json({ status: 'success', data: payment });
    } catch (err) {
      next(err);
    }
  });

  router.get('/reports/reconciliation', requirePermission('users.manage'), (req, res, next) => {
    try {
      const companyId = 1;
      const report = reconciliationService.runReconciliation(companyId);
      res.status(200).json({ status: 'success', data: report });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/reports/reconciliation/repair',
    requirePermission('users.manage'),
    (req, res, next) => {
      try {
        const companyId = 1;
        reconciliationService.repairLedgerBalances(companyId);
        res
          .status(200)
          .json({ status: 'success', message: 'Ledger balances successfully repaired.' });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
