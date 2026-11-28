import { AppError } from '../../shared/errors/app-error.js';
import { AccountingPostingEngine } from './posting-engine.service.js';
import { createInventoryService } from '../inventory/inventory.service.js';
import { assertCustomerCreditLimit } from './customer-credit.service.js';
import { DocumentSeries, nextDocumentNumber } from '../../shared/utils/document-number.js';
import { releaseDocumentAllocations } from './allocation.service.js';
import { roundMoney } from '../../shared/utils/numbers.js';
import { isIsoDate } from '../../shared/utils/validation.js';
import { taxLines, withRoundOff } from './ledgers.js';
import { isInterstate } from '../settings/company-settings.js';

const sumQuantity = (batches) =>
  batches.reduce((total, batch) => total + Number(batch.quantity), 0);

/**
 * Service to manage direct (non-job-card) counter billing.
 */
export class DirectBillingService {
  constructor(db) {
    this.db = db;
    this.postingEngine = new AccountingPostingEngine(db);
    this.inventoryService = createInventoryService(db);
  }

  /**
   * Takes stock out from the oldest batches first; the cost is the item's
   * weighted average. Returns the total cost of what was taken.
   */
  deductStock(itemId, warehouseId, quantity, invoiceId, userId) {
    let remaining = Number(quantity);
    const batches = this.db
      .prepare(
        `SELECT id, quantity FROM inventory_batches
         WHERE item_id = ? AND warehouse_id = ? AND quantity > 0 ORDER BY id`,
      )
      .all(itemId, warehouseId);
    if (sumQuantity(batches) < remaining)
      throw new AppError(
        'Not enough stock of this item in the selected godown.',
        400,
        'INSUFFICIENT_STOCK',
      );

    let totalCost = 0;
    for (const batch of batches) {
      if (remaining <= 0) break;
      const deduct = Math.min(batch.quantity, remaining);
      const movement = this.inventoryService.stockOut({
        itemId,
        warehouseId,
        batchId: batch.id,
        quantity: deduct,
        transactionType: 'Consumption',
        referenceType: 'direct_invoices',
        referenceId: invoiceId,
        notes: `Direct counter sale`,
        userId,
      });

      totalCost += roundMoney(deduct * movement.unitCost);
      remaining = roundMoney(remaining - deduct);
    }
    return roundMoney(totalCost);
  }

  /** The shared customer record used for walk-in counter sales without a name. */
  walkInCustomerId() {
    const existing = this.db
      .prepare("SELECT id FROM customers WHERE name = 'Walk-in customer' ORDER BY id LIMIT 1")
      .get();
    if (existing) return existing.id;
    return Number(
      this.db
        .prepare(
          "INSERT INTO customers (name, notes) VALUES ('Walk-in customer', 'Counter sales without a name')",
        )
        .run().lastInsertRowid,
    );
  }

  /** Latest 200 counter bills, optionally for one customer or status. */
  listDirectInvoices({ customerId, status } = {}, companyId = 1) {
    let sql = `SELECT di.*, c.name AS customer_name
      FROM direct_invoices di JOIN customers c ON di.customer_id = c.id
      WHERE di.company_id = ?`;
    const params = [companyId];
    if (customerId) {
      sql += ' AND di.customer_id = ?';
      params.push(customerId);
    }
    if (status) {
      sql += ' AND di.status = ?';
      params.push(status);
    }
    return this.db
      .prepare(`${sql} ORDER BY di.invoice_date DESC, di.id DESC LIMIT 200`)
      .all(...params);
  }

  /** One counter bill with its lines. */
  getDirectInvoice(id, companyId = 1) {
    const invoice = this.db
      .prepare('SELECT * FROM direct_invoices WHERE id = ? AND company_id = ?')
      .get(id, companyId);
    if (!invoice) throw new AppError('Counter bill not found.', 404, 'NOT_FOUND');
    const items = this.db
      .prepare(
        `SELECT dii.*, ii.item_name, ii.sku, ii.hsn_code
         FROM direct_invoice_items dii LEFT JOIN inventory_items ii ON dii.item_id = ii.id
         WHERE dii.direct_invoice_id = ?`,
      )
      .all(invoice.id);
    return { ...invoice, items };
  }

  /** Makes a counter bill: posts the sale, takes the stock out and books its cost. */
  createDirectInvoice(payload) {
    const {
      companyId = 1,
      customerId,
      invoiceDate,
      items,
      narration = '',
      createdBy = null,
    } = payload;

    // 1. Validations
    if (!customerId || !invoiceDate || !items || !Array.isArray(items) || items.length === 0) {
      throw new AppError(
        'Customer, date, and items are required.',
        400,
        'DIRECT_BILLING_INVALID_PAYLOAD',
      );
    }

    if (!isIsoDate(invoiceDate)) {
      throw new AppError('Invoice date must be YYYY-MM-DD.', 400, 'DIRECT_BILLING_INVALID_DATE');
    }

    // Verify customer exists
    const customer = this.db
      .prepare('SELECT name, ledger_id, state FROM customers WHERE id = ?')
      .get(customerId);
    if (!customer) {
      throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
    }

    const interstate = isInterstate(this.db, customer.state);
    const customerLedgerId = this.postingEngine.getOrCreateCustomerLedger(companyId, customerId);

    return this.db.transaction(() => {
      // 2. Reserve the next GST invoice number for the invoice's financial year
      const invoiceNumber = nextDocumentNumber(
        this.db,
        DocumentSeries.COUNTER_INVOICE,
        invoiceDate,
      );

      // Insert dummy invoice to get ID for references
      const dummyInfo = this.db
        .prepare(
          `
        INSERT INTO direct_invoices (
          invoice_number, company_id, customer_id, invoice_date, subtotal, gst_total, grand_total, status, narration, created_by, cgst_total, sgst_total, igst_total
        ) VALUES (?, ?, ?, ?, 0, 0, 0, 'UNPAID', ?, ?, 0, 0, 0)
      `,
        )
        .run(invoiceNumber, companyId, customerId, invoiceDate, narration, createdBy);

      const invoiceId = dummyInfo.lastInsertRowid;

      let subtotal = 0;
      let gstTotal = 0;
      let totalPartsCost = 0;
      let totalPartsRevenue = 0;
      let totalLabourRevenue = 0;

      const processedItems = [];

      // 3. Process items and deduct stock if parts
      for (const item of items) {
        const qty = Number(item.quantity);
        const price = Number(item.unitPrice);
        const gstRate = Number(item.gstRate || 0);

        if (
          !Number.isFinite(qty) ||
          !Number.isFinite(price) ||
          !Number.isFinite(gstRate) ||
          qty <= 0 ||
          price < 0 ||
          gstRate < 0 ||
          gstRate > 100
        ) {
          throw new AppError(
            'Quantity and price must be positive numbers.',
            400,
            'DIRECT_BILLING_INVALID_ITEM_VALUES',
          );
        }

        const lineSubtotal = roundMoney(qty * price);
        const lineGst = roundMoney(lineSubtotal * (gstRate / 100));
        const lineTotal = roundMoney(lineSubtotal + lineGst);

        let costPrice = 0;
        let lineCost = 0;

        if (item.itemId) {
          // Verify inventory item
          const invItem = this.db
            .prepare('SELECT item_name FROM inventory_items WHERE id = ?')
            .get(item.itemId);
          if (!invItem) {
            throw new AppError(
              `Inventory item ID ${item.itemId} not found.`,
              404,
              'INVENTORY_ITEM_NOT_FOUND',
            );
          }

          if (!item.warehouseId) {
            throw new AppError(
              `Warehouse ID is required for inventory part ${invItem.item_name}.`,
              400,
              'WAREHOUSE_REQUIRED',
            );
          }

          // Deduct stock and retrieve cost
          lineCost = this.deductStock(item.itemId, item.warehouseId, qty, invoiceId, createdBy);
          costPrice = roundMoney(lineCost / qty);
          totalPartsCost += lineCost;
          totalPartsRevenue += lineSubtotal;
        } else {
          totalLabourRevenue += lineSubtotal;
        }

        subtotal += lineSubtotal;
        gstTotal += lineGst;

        processedItems.push({
          itemId: item.itemId || null,
          description: item.description || (item.itemId ? 'Spare Part' : 'Labor Service'),
          quantity: qty,
          unitPrice: price,
          gstRate,
          gstAmount: lineGst,
          lineTotal,
          costPrice,
          lineCost,
          warehouseId: item.warehouseId || null,
        });
      }

      const grandTotal = Math.round(subtotal + gstTotal);
      assertCustomerCreditLimit(this.db, companyId, customerId, grandTotal);

      const cgst = interstate ? 0 : roundMoney(gstTotal / 2);
      const sgst = interstate ? 0 : roundMoney(gstTotal - cgst);
      const igst = interstate ? roundMoney(gstTotal) : 0;

      // Save processed invoice items
      const insertItem = this.db.prepare(`
        INSERT INTO direct_invoice_items (
          direct_invoice_id, item_id, description, quantity, unit_price, gst_rate, gst_amount, line_total, cost_price, warehouse_id, line_cost
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of processedItems) {
        insertItem.run(
          invoiceId,
          item.itemId,
          item.description,
          item.quantity,
          item.unitPrice,
          item.gstRate,
          item.gstAmount,
          item.lineTotal,
          item.costPrice,
          item.warehouseId,
          item.lineCost,
        );
      }

      // Sales voucher (the bill is rounded to whole rupees; round-off takes the
      // difference), then the parts' cost moves from stock into COGS.
      const ledger = (key) => this.postingEngine.ledgerResolver.getLedgerId(companyId, key);
      const salesEntries = [{ ledgerId: customerLedgerId, type: 'DEBIT', amount: grandTotal }];
      if (totalPartsRevenue > 0)
        salesEntries.push({
          ledgerId: ledger('parts_sales'),
          type: 'CREDIT',
          amount: totalPartsRevenue,
        });
      if (totalLabourRevenue > 0)
        salesEntries.push({
          ledgerId: ledger('labour_sales'),
          type: 'CREDIT',
          amount: totalLabourRevenue,
        });
      salesEntries.push(...taxLines(ledger, { cgst, sgst, igst }, 'CREDIT', 'output'));
      const salesVoucher = this.postingEngine.post({
        companyId,
        voucherType: 'Sales',
        voucherDate: invoiceDate,
        referenceTable: 'direct_invoices',
        referenceId: invoiceId,
        narration: narration || `Direct counter sale invoice ${invoiceNumber}`,
        created_by: createdBy,
        entries: withRoundOff(ledger, salesEntries),
      });

      const cogsVoucherId =
        totalPartsCost > 0
          ? this.postingEngine.post({
              companyId,
              voucherType: 'Journal',
              voucherDate: invoiceDate,
              referenceTable: 'direct_invoices',
              referenceId: invoiceId,
              narration: `Cost of goods sold for direct counter invoice ${invoiceNumber}`,
              created_by: createdBy,
              entries: [
                { ledgerId: ledger('cogs'), type: 'DEBIT', amount: totalPartsCost },
                { ledgerId: ledger('inventory_stock'), type: 'CREDIT', amount: totalPartsCost },
              ],
            }).voucherId
          : null;

      // 5. Update main invoice document with final calculations and voucher links
      this.db
        .prepare(
          `
        UPDATE direct_invoices
        SET subtotal = ?, gst_total = ?, grand_total = ?, voucher_id = ?, cogs_voucher_id = ?, cgst_total = ?, sgst_total = ?, igst_total = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        )
        .run(
          subtotal,
          gstTotal,
          grandTotal,
          salesVoucher.voucherId,
          cogsVoucherId,
          cgst,
          sgst,
          igst,
          invoiceId,
        );

      return {
        invoiceId,
        invoiceNumber,
        invoiceDate,
        customerId,
        grandTotal,
        voucherId: salesVoucher.voucherId,
        cogsVoucherId,
      };
    })();
  }

  /**
   * Cancels a direct invoice, cancels linked vouchers, and rolls back inventory stock.
   */
  cancelDirectInvoice(invoiceId, companyId = 1, userId = null) {
    return this.db.transaction(() => {
      const invoice = this.db
        .prepare('SELECT * FROM direct_invoices WHERE id = ? AND company_id = ?')
        .get(invoiceId, companyId);
      if (!invoice) {
        throw new AppError('Direct invoice not found.', 404, 'INVOICE_NOT_FOUND');
      }

      // Bills from the old Sales Orders shipments must go through a return.
      if (invoice.sales_shipment_id) {
        throw new AppError(
          'Shipment invoices require a sales return; direct cancellation is unavailable.',
          409,
          'SHIPMENT_INVOICE_LOCKED',
        );
      }

      if (invoice.status === 'CANCELLED') {
        throw new AppError('Invoice is already cancelled.', 400, 'INVOICE_ALREADY_CANCELLED');
      }

      // Money already paid on this bill stays with the customer as an advance.
      const advanceKept = releaseDocumentAllocations(this.db, 'direct_invoice', invoice.id);
      if (advanceKept > 0)
        this.db.prepare('UPDATE direct_invoices SET amount_paid = 0 WHERE id = ?').run(invoice.id);

      // Reverse actual batch movements, including invoices spanning several batches.
      const movements = this.db
        .prepare(
          `
        SELECT t.*, b.batch_number, b.supplier_id, b.manufacture_date, b.expiry_date
        FROM inventory_transactions t JOIN inventory_batches b ON b.id = t.batch_id
        WHERE t.reference_type = 'direct_invoices' AND t.reference_id = ?
          AND t.direction = 'OUT' AND t.transaction_type = 'Consumption'
        ORDER BY t.id
      `,
        )
        .all(invoiceId);
      for (const movement of movements) {
        this.inventoryService.stockIn({
          itemId: movement.item_id,
          warehouseId: movement.warehouse_id,
          supplierId: movement.supplier_id,
          batchNumber: movement.batch_number,
          manufactureDate: movement.manufacture_date,
          expiryDate: movement.expiry_date,
          quantity: movement.quantity,
          unitCost: movement.unit_cost,
          transactionType: 'Return',
          referenceType: 'direct_invoices',
          referenceId: invoiceId,
          notes: 'Direct invoice cancellation',
          userId,
        });
      }

      // 2. Reverse accounting ledger lines
      if (invoice.voucher_id) {
        this.postingEngine.deleteVoucher(companyId, invoice.voucher_id);
      }
      if (invoice.cogs_voucher_id) {
        this.postingEngine.deleteVoucher(companyId, invoice.cogs_voucher_id);
      }

      // 3. Mark status as CANCELLED
      this.db
        .prepare(
          "UPDATE direct_invoices SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(invoiceId);

      return { cancelled: true, advance_kept: advanceKept };
    })();
  }
}
