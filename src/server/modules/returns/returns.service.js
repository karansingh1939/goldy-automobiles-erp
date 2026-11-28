import { localDate } from '../../shared/utils/local-date.js';
import { recordSupplierLedgerEntry } from '../purchasing/supplier-ledger.js';
import { DocumentSeries, nextDocumentNumber } from '../../shared/utils/document-number.js';
import { AppError } from '../../shared/errors/app-error.js';
import { ReturnsRepository } from './returns.repository.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { AccountingPostingEngine } from '../accounting/posting-engine.service.js';
import { AllocationService } from '../accounting/allocation.service.js';
import { roundMoney } from '../../shared/utils/numbers.js';
import { taxLines, withRoundOff } from '../accounting/ledgers.js';

const sum = (rows, value) => rows.reduce((total, row) => total + value(row), 0);
const taxTotals = (items) => ({
  cgst: sum(items, (item) => item.cgst_amount || 0),
  sgst: sum(items, (item) => item.sgst_amount || 0),
  igst: sum(items, (item) => item.igst_amount || 0),
});

export class ReturnsService {
  constructor(db) {
    this.db = db;
    this.repository = new ReturnsRepository(db);
    this.inventoryService = new InventoryService(db);
    this.postingEngine = new AccountingPostingEngine(db);
  }

  // CUSTOMER RETURNS
  createCustomerReturn(payload, userId) {
    const { invoiceId, items, returnDate } = payload;
    if (!invoiceId || !items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('Invoice ID and items are required.', 400, 'VALIDATION_ERROR');
    }

    const invoice = this.repository.findInvoiceById(invoiceId);
    if (!invoice || invoice.status !== 'FINALIZED') {
      throw new AppError(
        'A finalized invoice is required for customer returns.',
        400,
        'VALIDATION_ERROR',
      );
    }

    const date = returnDate || localDate();

    return this.repository.transaction(() => {
      let totalRefundAmount = 0;
      const processedItems = [];
      const seenItems = new Set();

      for (const item of items) {
        const invItem = this.repository.findInvoiceItem(invoiceId, item.itemId, item.invoiceItemId);
        if (
          !invItem ||
          !invItem.inventory_item_id ||
          (item.itemId && Number(item.itemId) !== Number(invItem.inventory_item_id))
        ) {
          throw new AppError(
            'Selected invoice line does not match this invoice part.',
            400,
            'VALIDATION_ERROR',
          );
        }
        if (seenItems.has(invItem.id)) {
          throw new AppError('Duplicate return items are not allowed.', 400, 'VALIDATION_ERROR');
        }
        seenItems.add(invItem.id);

        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new AppError('Return quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
        }

        const alreadyReturned = this.repository.getAlreadyReturnedQuantity(invoiceId, invItem);
        const remaining = Number(invItem.quantity) - alreadyReturned;
        if (quantity > remaining) {
          throw new AppError(
            `Cannot return ${quantity} of item ${item.itemId}. Already returned: ${alreadyReturned}, remaining: ${remaining}.`,
            400,
            'VALIDATION_ERROR',
          );
        }

        const batch = this.inventoryService.repository.findBatchById(invItem.batch_id);
        if (
          !batch ||
          Number(batch.item_id) !== Number(invItem.inventory_item_id) ||
          (item.batchId && Number(item.batchId) !== Number(batch.id)) ||
          (item.warehouseId && Number(item.warehouseId) !== Number(batch.warehouse_id))
        ) {
          throw new AppError('Return batch must match the invoice batch.', 400, 'VALIDATION_ERROR');
        }
        if (item.condition && !['GOOD', 'DAMAGED'].includes(item.condition)) {
          throw new AppError('Return condition must be GOOD or DAMAGED.', 400, 'VALIDATION_ERROR');
        }
        const ratio = quantity / Number(invItem.quantity);
        const cgstAmount = roundMoney(Number(invItem.cgst_amount) * ratio);
        const sgstAmount = roundMoney(Number(invItem.sgst_amount) * ratio);
        const igstAmount = roundMoney(Number(invItem.igst_amount) * ratio);
        const gstAmount = cgstAmount + sgstAmount + igstAmount;
        const lineTotal = roundMoney(Number(invItem.line_total) * ratio);

        totalRefundAmount += lineTotal;

        processedItems.push({
          invoice_item_id: invItem.id,
          item_id: invItem.inventory_item_id,
          warehouse_id: batch.warehouse_id,
          batch_id: batch.id,
          quantity,
          unit_price: (lineTotal - gstAmount) / quantity,
          gst_rate: Number(invItem.gst_rate),
          gst_amount: gstAmount,
          cgst_amount: cgstAmount,
          sgst_amount: sgstAmount,
          igst_amount: igstAmount,
          line_total: lineTotal,
          condition: item.condition || 'GOOD',
        });
      }

      const customerReturn = this.repository.createCustomerReturn({
        return_number: nextDocumentNumber(this.db, DocumentSeries.CREDIT_NOTE, date),
        company_id: invoice.company_id || 1,
        customer_id: invoice.customer_id,
        invoice_id: invoiceId,
        return_date: date,
        status: 'DRAFT',
        total_refund_amount: totalRefundAmount,
        credit_note_id: null,
        created_by: userId,
      });

      for (const pItem of processedItems) {
        this.repository.createCustomerReturnItem({
          customer_return_id: customerReturn.id,
          ...pItem,
        });
      }

      return this.repository.findCustomerReturnById(customerReturn.id);
    });
  }

  completeCustomerReturn(returnId, userId) {
    return this.repository.transaction(() => {
      const ret = this.repository.findCustomerReturnById(returnId);
      if (!ret) {
        throw new AppError('Customer return not found.', 404, 'ITEM_NOT_FOUND');
      }
      if (ret.status !== 'DRAFT') {
        throw new AppError(
          `Cannot approve a return with status ${ret.status}.`,
          400,
          'VALIDATION_ERROR',
        );
      }

      const companyId = ret.company_id || 1;
      const invoice = this.repository.findInvoiceById(ret.invoice_id);
      if (!invoice || invoice.status !== 'FINALIZED') {
        throw new AppError(
          'A finalized invoice is required for customer returns.',
          400,
          'VALIDATION_ERROR',
        );
      }

      // 1. Good parts go back into stock at the cost they were sold at.
      const ledger = (key) => this.postingEngine.ledgerResolver.getLedgerId(companyId, key);
      const lines = ret.items.map((item) => {
        this.inventoryService.assertWarehousePermission(userId, item.warehouse_id);
        const invItem = this.repository.findInvoiceItem(
          ret.invoice_id,
          item.item_id,
          item.invoice_item_id,
          item.batch_id,
        );
        if (!invItem)
          throw new AppError(
            'Original invoice line is missing. Reconcile this return before approval.',
            409,
            'RETURN_LINE_MISSING',
          );
        const unitCost = Number(invItem.purchase_cost_snapshot);
        if (item.condition === 'GOOD') {
          const batch = this.inventoryService.repository.findBatchById(item.batch_id);
          this.inventoryService.stockIn({
            itemId: item.item_id,
            warehouseId: item.warehouse_id,
            batchNumber: batch ? batch.batch_number : `B-${Date.now()}`,
            quantity: item.quantity,
            unitCost,
            transactionType: 'Return',
            referenceType: 'customer_returns',
            referenceId: ret.id,
            userId,
          });
        }
        return { item, unitCost };
      });

      // 2. Credit note: the customer is owed the refund; sales and output GST go down.
      const entries = [
        {
          ledgerId: this.postingEngine.getOrCreateCustomerLedger(companyId, ret.customer_id),
          type: 'CREDIT',
          amount: roundMoney(ret.total_refund_amount),
        },
        {
          ledgerId: ledger('parts_sales'),
          type: 'DEBIT',
          amount: roundMoney(sum(ret.items, (item) => item.line_total - item.gst_amount)),
        },
        ...taxLines(ledger, taxTotals(ret.items), 'DEBIT', 'output'),
      ];

      const voucher = this.postingEngine.post({
        companyId,
        voucherType: 'Credit Note',
        voucherDate: ret.return_date,
        referenceTable: 'customer_returns',
        referenceId: ret.id,
        narration: `Credit Note for customer return ${ret.return_number}`,
        created_by: userId,
        entries: withRoundOff(ledger, entries),
      });

      // 3. Reverse the cost of goods sold: back into stock if good, a loss if damaged.
      for (const { item, unitCost } of lines) {
        const totalCost = roundMoney(unitCost * item.quantity);
        if (totalCost <= 0) continue;
        const good = item.condition === 'GOOD';
        this.postingEngine.post({
          companyId,
          voucherType: 'Journal',
          voucherDate: ret.return_date,
          referenceTable: 'customer_returns',
          referenceId: ret.id,
          narration: good
            ? `COGS Reversal for returned item SKU ${item.sku}`
            : `Write-off for damaged returned item SKU ${item.sku}`,
          created_by: userId,
          entries: [
            {
              ledgerId: ledger(good ? 'inventory_stock' : 'damaged_stock_loss'),
              type: 'DEBIT',
              amount: totalCost,
            },
            { ledgerId: ledger('cogs'), type: 'CREDIT', amount: totalCost },
          ],
        });
      }

      const completed = this.repository.updateCustomerReturn(ret.id, {
        status: 'COMPLETED',
        credit_note_id: voucher.voucherId,
      });
      new AllocationService(this.db).reconcileInvoiceCredits(ret.invoice_id);
      return completed;
    });
  }

  cancelCustomerReturn(returnId, userId) {
    const ret = this.repository.findCustomerReturnById(returnId);
    if (!ret) {
      throw new AppError('Customer return not found.', 404, 'ITEM_NOT_FOUND');
    }
    if (ret.status !== 'DRAFT') {
      throw new AppError(
        `Cannot cancel a return with status ${ret.status}.`,
        400,
        'VALIDATION_ERROR',
      );
    }

    return this.repository.updateCustomerReturn(ret.id, {
      status: 'CANCELLED',
    });
  }

  // SUPPLIER RETURNS
  createSupplierReturn(payload, userId) {
    const { supplierId, purchaseId, items, returnDate } = payload;
    if (!supplierId || !items || !Array.isArray(items) || items.length === 0) {
      throw new AppError('Supplier ID and items are required.', 400, 'VALIDATION_ERROR');
    }

    const date = returnDate || localDate();
    const companyId = 1; // default company

    return this.repository.transaction(() => {
      let totalRefundAmount = 0;
      const processedItems = [];
      const seenSources = new Set();

      for (const item of items) {
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new AppError('Return quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
        }

        // Validate batch exists and belongs to correct warehouse
        const batch = this.db
          .prepare('SELECT * FROM inventory_batches WHERE id = ?')
          .get(item.batchId);
        if (!batch || Number(batch.item_id) !== Number(item.itemId)) {
          throw new AppError(
            `Batch ${item.batchId} does not match item ${item.itemId}.`,
            400,
            'VALIDATION_ERROR',
          );
        }

        if (batch.supplier_id && Number(batch.supplier_id) !== Number(supplierId)) {
          throw new AppError(
            'Return supplier must match the batch supplier.',
            400,
            'RETURN_SUPPLIER_MISMATCH',
          );
        }
        const source = this.repository.supplierReturnSource(batch.id, supplierId, purchaseId, item);
        const sourceKey = `${source.source_table}:${source.id}`;
        if (seenSources.has(sourceKey))
          throw new AppError(
            'Duplicate supplier return purchase lines are not allowed.',
            400,
            'VALIDATION_ERROR',
          );
        seenSources.add(sourceKey);
        const alreadyReturned = this.repository.supplierReturnedQuantity(source);
        if (quantity > source.quantity - alreadyReturned)
          throw new AppError(
            'Return quantity exceeds the remaining original purchase quantity.',
            400,
            'VALIDATION_ERROR',
          );

        if (Number(batch.quantity) < quantity) {
          throw new AppError(
            `Insufficient stock in batch ${batch.batch_number} to execute return. Available: ${batch.quantity}.`,
            400,
            'INSUFFICIENT_STOCK',
          );
        }

        const unitCost = Number(source.purchase_cost);
        const gstRate = Number(source.gst_rate);

        // Calculate tax input reversal
        const taxable = roundMoney(unitCost * quantity);
        const gstAmount = roundMoney((source.gst_amount * quantity) / source.quantity);
        const cgstAmount = source.interstate ? 0 : roundMoney(gstAmount / 2);
        const sgstAmount = source.interstate ? 0 : roundMoney(gstAmount - cgstAmount);
        const lineTotal = roundMoney(taxable + gstAmount);

        totalRefundAmount += lineTotal;

        processedItems.push({
          item_id: item.itemId,
          warehouse_id: batch.warehouse_id,
          batch_id: batch.id,
          quantity,
          unit_cost: unitCost,
          gst_rate: gstRate,
          gst_amount: gstAmount,
          line_total: lineTotal,
          source_table: source.source_table,
          source_item_id: source.id,
          cgst_amount: cgstAmount,
          sgst_amount: sgstAmount,
          igst_amount: source.interstate ? gstAmount : 0,
        });
      }

      const supplierReturn = this.repository.createSupplierReturn({
        return_number: nextDocumentNumber(this.db, DocumentSeries.DEBIT_NOTE, date),
        company_id: companyId,
        supplier_id: supplierId,
        purchase_id: purchaseId || null,
        return_date: date,
        status: 'DRAFT',
        total_refund_amount: totalRefundAmount,
        debit_note_id: null,
        created_by: userId,
      });

      for (const pItem of processedItems) {
        this.repository.createSupplierReturnItem({
          supplier_return_id: supplierReturn.id,
          ...pItem,
        });
      }

      return this.repository.findSupplierReturnById(supplierReturn.id);
    });
  }

  completeSupplierReturn(returnId, userId) {
    return this.repository.transaction(() => {
      const ret = this.repository.findSupplierReturnById(returnId);
      if (!ret) {
        throw new AppError('Supplier return not found.', 404, 'ITEM_NOT_FOUND');
      }
      if (ret.status !== 'DRAFT') {
        throw new AppError(
          `Cannot approve a supplier return with status ${ret.status}.`,
          400,
          'VALIDATION_ERROR',
        );
      }

      const companyId = ret.company_id || 1;

      for (const item of ret.items) {
        const source = this.repository.supplierReturnSource(
          item.batch_id,
          ret.supplier_id,
          ret.purchase_id,
          item,
        );
        if (
          item.quantity >
          source.quantity - this.repository.supplierReturnedQuantity(source, ret.id)
        ) {
          throw new AppError(
            'Return quantity exceeds the remaining original purchase quantity.',
            400,
            'VALIDATION_ERROR',
          );
        }
        const expectedGst = roundMoney((source.gst_amount * item.quantity) / source.quantity);
        if (
          Math.abs(item.unit_cost - source.purchase_cost) > 0.005 ||
          Math.abs(item.gst_amount - expectedGst) > 0.005
        ) {
          throw new AppError(
            'Return draft valuation does not match the original purchase. Cancel and recreate this draft.',
            409,
            'RETURN_VALUATION_MISMATCH',
          );
        }
        if (item.cgst_amount === null || item.sgst_amount === null || item.igst_amount === null) {
          item.igst_amount = source.interstate ? item.gst_amount : 0;
          item.cgst_amount = source.interstate ? 0 : roundMoney(item.gst_amount / 2);
          item.sgst_amount = source.interstate ? 0 : roundMoney(item.gst_amount - item.cgst_amount);
          this.db
            .prepare(
              'UPDATE supplier_return_items SET source_table=?,source_item_id=?,cgst_amount=?,sgst_amount=?,igst_amount=? WHERE id=?',
            )
            .run(
              source.source_table,
              source.id,
              item.cgst_amount,
              item.sgst_amount,
              item.igst_amount,
              item.id,
            );
        }
      }

      let inventoryValue = 0;
      // 1. Process Stock Outflows
      for (const item of ret.items) {
        const movement = this.inventoryService.stockOut({
          itemId: item.item_id,
          warehouseId: item.warehouse_id,
          batchId: item.batch_id,
          quantity: item.quantity,
          transactionType: 'Return',
          referenceType: 'supplier_returns',
          referenceId: ret.id,
          userId,
        });
        inventoryValue += roundMoney(movement.unitCost * item.quantity);
      }

      // 2. Debit note: the supplier owes us the refund; stock and input GST go down.
      // Stock leaves at today's average cost; any gap to the bought price is an adjustment.
      const ledger = (key) => this.postingEngine.ledgerResolver.getLedgerId(companyId, key);
      const costDifference = roundMoney(
        inventoryValue - sum(ret.items, (item) => item.unit_cost * item.quantity),
      );
      const entries = [
        {
          ledgerId: this.postingEngine.getOrCreateSupplierLedger(companyId, ret.supplier_id),
          type: 'DEBIT',
          amount: roundMoney(ret.total_refund_amount),
        },
        { ledgerId: ledger('inventory_stock'), type: 'CREDIT', amount: roundMoney(inventoryValue) },
        ...taxLines(ledger, taxTotals(ret.items), 'CREDIT', 'input'),
      ];
      if (costDifference !== 0)
        entries.push({
          ledgerId: ledger('stock_adjustments'),
          type: costDifference > 0 ? 'DEBIT' : 'CREDIT',
          amount: Math.abs(costDifference),
        });

      const voucher = this.postingEngine.post({
        companyId,
        voucherType: 'Debit Note',
        voucherDate: ret.return_date,
        referenceTable: 'supplier_returns',
        referenceId: ret.id,
        narration: `Debit Note for supplier return ${ret.return_number}`,
        created_by: userId,
        entries: withRoundOff(ledger, entries),
      });

      // Goods sent back lower what we owe this supplier on the Supplier Ledger.
      recordSupplierLedgerEntry(this.db, {
        supplierId: ret.supplier_id,
        date: ret.return_date,
        entryType: 'Return',
        referenceType: 'supplier_returns',
        referenceId: ret.id,
        debit: ret.total_refund_amount,
        notes: `Returned goods ${ret.return_number}`,
        userId,
      });

      return this.repository.updateSupplierReturn(ret.id, {
        status: 'COMPLETED',
        debit_note_id: voucher.voucherId,
      });
    });
  }

  cancelSupplierReturn(returnId, userId) {
    const ret = this.repository.findSupplierReturnById(returnId);
    if (!ret) {
      throw new AppError('Supplier return not found.', 404, 'ITEM_NOT_FOUND');
    }
    if (ret.status !== 'DRAFT') {
      throw new AppError(
        `Cannot cancel a supplier return with status ${ret.status}.`,
        400,
        'VALIDATION_ERROR',
      );
    }

    return this.repository.updateSupplierReturn(ret.id, {
      status: 'CANCELLED',
    });
  }
}
