import { localDate } from '../../shared/utils/local-date.js';
import { DocumentSeries, nextDocumentNumber } from '../../shared/utils/document-number.js';
import { AppError } from '../../shared/errors/app-error.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PurchasingRepository } from './purchasing.repository.js';
import { AccountingPostingEngine } from '../accounting/posting-engine.service.js';
import { toNumber, roundMoney } from '../../shared/utils/numbers.js';
import { pageInfo, parsePaging, required } from '../../shared/utils/validation.js';

function lineAmounts(item) {
  const quantity = toNumber(item.quantity);
  const purchaseCost = roundMoney(item.purchase_cost ?? item.unit_cost);
  const gstRate = toNumber(item.gst_rate);
  const taxable = roundMoney(quantity * purchaseCost);
  const gstAmount = roundMoney((taxable * gstRate) / 100);

  return {
    quantity,
    purchaseCost,
    gstRate,
    gstAmount,
    lineTotal: roundMoney(taxable + gstAmount),
  };
}

export class PurchasingService {
  constructor(db) {
    this.db = db;
    this.repository = new PurchasingRepository(db);
    this.inventoryService = new InventoryService(db);
    this.auditRepository = new AuditRepository(db);
    this.postingEngine = new AccountingPostingEngine(db);
  }

  listOrders(query = {}) {
    const parsed = parsePaging(query);
    const result = this.repository.listPurchaseOrders(parsed);
    return this.withPagination(result, parsed);
  }

  getOrder(id) {
    const order = this.repository.findPurchaseOrderById(id);
    if (!order) {
      throw new AppError('Purchase order not found.', 404, 'PURCHASE_ORDER_NOT_FOUND');
    }

    return {
      ...order,
      items: this.repository.listPurchaseItemsByOrderId(id),
    };
  }

  createOrder(payload, userId) {
    required(payload.supplier_id, 'Supplier');
    const supplier = this.repository.findSupplierById(payload.supplier_id);
    if (!supplier) {
      throw new AppError('Supplier was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    if (!supplier.is_active) {
      throw new AppError('Supplier is inactive.', 400, 'VALIDATION_ERROR');
    }

    const items = this.validateItems(payload.items, { requireBatch: false });

    return this.repository.transaction(() => {
      const orderId = this.repository.createPurchaseOrder({
        order_number:
          payload.order_number ||
          nextDocumentNumber(this.db, DocumentSeries.PURCHASE_ORDER, localDate()),
        supplier_id: supplier.id,
        order_date: payload.order_date || localDate(),
        expected_date: payload.expected_date || null,
        status: 'OPEN',
        notes: payload.notes || null,
        created_by: userId,
      });

      const totals = this.createPurchaseItems({
        source: 'order',
        sourceId: orderId,
        items,
      });
      this.repository.updatePurchaseOrderTotals(orderId, totals);

      const order = this.getOrder(orderId);
      this.auditRepository.create({
        userId,
        action: 'CREATE',
        entityType: 'purchase_orders',
        entityId: orderId,
        newValue: order,
      });

      return order;
    });
  }

  listReceipts(query = {}) {
    const parsed = parsePaging(query);
    const result = this.repository.listPurchaseReceipts(parsed);
    return this.withPagination(result, parsed);
  }

  getReceipt(id) {
    const receipt = this.repository.findPurchaseReceiptById(id);
    if (!receipt) {
      throw new AppError('Purchase receipt not found.', 404, 'PURCHASE_RECEIPT_NOT_FOUND');
    }

    return {
      ...receipt,
      items: this.repository.listPurchaseItemsByReceiptId(id),
    };
  }

  createReceipt(payload, userId) {
    required(payload.supplier_id, 'Supplier');
    const supplier = this.repository.findSupplierById(payload.supplier_id);
    if (!supplier) {
      throw new AppError('Supplier was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    if (!supplier.is_active) {
      throw new AppError('Supplier is inactive.', 400, 'VALIDATION_ERROR');
    }

    const purchaseOrder = payload.purchase_order_id
      ? this.repository.findPurchaseOrderById(payload.purchase_order_id)
      : null;

    if (payload.purchase_order_id && !purchaseOrder) {
      throw new AppError('Purchase order was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    if (purchaseOrder && Number(purchaseOrder.supplier_id) !== Number(supplier.id)) {
      throw new AppError(
        'Purchase order supplier does not match receipt supplier.',
        400,
        'VALIDATION_ERROR',
      );
    }

    const receiptNumber =
      payload.receipt_number ||
      nextDocumentNumber(
        this.db,
        DocumentSeries.GOODS_RECEIPT,
        payload.receipt_date || localDate(),
      );
    // Spare parts rarely carry real batch numbers; when left blank, the
    // supplier bill number identifies the lot so the owner can skip the field.
    const withBatches = Array.isArray(payload.items)
      ? payload.items.map((item) =>
          item && !item.batch_id && !String(item.batch_number ?? '').trim()
            ? { ...item, batch_number: String(receiptNumber).trim() }
            : item,
        )
      : payload.items;
    const items = this.validateItems(withBatches, { requireBatch: true });

    return this.repository.transaction(() => {
      const receiptId = this.repository.createPurchaseReceipt({
        receipt_number: receiptNumber,
        purchase_order_id: purchaseOrder?.id || null,
        supplier_id: supplier.id,
        receipt_date: payload.receipt_date || localDate(),
        status: 'POSTED',
        notes: payload.notes || null,
        created_by: userId,
      });

      const totals = this.createPurchaseItems({
        source: 'receipt',
        sourceId: receiptId,
        supplierId: supplier.id,
        items,
        userId,
      });
      this.repository.updatePurchaseReceiptTotals(receiptId, totals);

      // Post Purchase Voucher automatically
      const supplierLedgerId = this.postingEngine.getOrCreateSupplierLedger(1, supplier.id);
      const companyState =
        this.db.prepare('SELECT state FROM companies WHERE id = 1').get()?.state || 'Haryana';
      const interstate =
        String(supplier.state || companyState)
          .trim()
          .toLowerCase() !== companyState.trim().toLowerCase();
      const igstAmount = interstate ? totals.gst_total : 0;
      const cgstAmount = interstate ? 0 : roundMoney(totals.gst_total / 2);
      const sgstAmount = interstate ? 0 : roundMoney(totals.gst_total - cgstAmount);

      const accountingEntries = [];
      accountingEntries.push({
        ledgerId: this.postingEngine.ledgerResolver.getLedgerId(1, 'inventory_stock'),
        type: 'DEBIT',
        amount: totals.subtotal,
      });

      if (cgstAmount > 0) {
        accountingEntries.push({
          ledgerId: this.postingEngine.ledgerResolver.getLedgerId(1, 'cgst_input'),
          type: 'DEBIT',
          amount: cgstAmount,
        });
      }
      if (sgstAmount > 0) {
        accountingEntries.push({
          ledgerId: this.postingEngine.ledgerResolver.getLedgerId(1, 'sgst_input'),
          type: 'DEBIT',
          amount: sgstAmount,
        });
      }

      accountingEntries.push({
        ledgerId: supplierLedgerId,
        type: 'CREDIT',
        amount: totals.grand_total,
      });

      if (igstAmount > 0) {
        accountingEntries.push({
          ledgerId: this.postingEngine.ledgerResolver.getLedgerId(1, 'igst_input'),
          type: 'DEBIT',
          amount: igstAmount,
        });
      }
      // Handle Round Off
      const sumDebits = totals.subtotal + cgstAmount + sgstAmount + igstAmount;
      const roundoff = roundMoney(totals.grand_total - sumDebits);
      if (Math.abs(roundoff) >= 0.01) {
        if (roundoff > 0) {
          accountingEntries.push({
            ledgerId: this.postingEngine.ledgerResolver.getLedgerId(1, 'round_off'),
            type: 'DEBIT',
            amount: roundoff,
          });
        } else {
          accountingEntries.push({
            ledgerId: this.postingEngine.ledgerResolver.getLedgerId(1, 'round_off'),
            type: 'CREDIT',
            amount: Math.abs(roundoff),
          });
        }
      }

      this.postingEngine.post({
        companyId: 1,
        voucherType: 'Purchase',
        voucherDate: payload.receipt_date || localDate(),
        referenceTable: 'purchase_receipts',
        referenceId: receiptId,
        narration: `Purchase receipt from supplier: ${supplier.name}. GRN: ${payload.receipt_number || receiptId}`,
        created_by: userId,
        entries: accountingEntries,
      });

      if (purchaseOrder) {
        this.repository.updatePurchaseOrderStatus(purchaseOrder.id, 'RECEIVED');
      }

      this.recordSupplierLedger({
        supplierId: supplier.id,
        entryDate: payload.receipt_date || localDate(),
        entryType: 'Purchase',
        referenceType: 'purchase_receipts',
        referenceId: receiptId,
        debit: 0,
        credit: totals.grand_total,
        notes: payload.notes || null,
        userId,
      });

      const receipt = this.getReceipt(receiptId);
      this.auditRepository.create({
        userId,
        action: 'CREATE',
        entityType: 'purchase_receipts',
        entityId: receiptId,
        newValue: receipt,
      });

      return receipt;
    });
  }

  validateItems(items, { requireBatch }) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError('At least one purchase item is required.', 400, 'VALIDATION_ERROR');
    }

    return items.map((item) => {
      required(item.item_id, 'Item');
      required(item.warehouse_id, 'Warehouse');
      required(item.quantity, 'Quantity');

      if (requireBatch) {
        required(item.batch_number ?? item.batch_id, 'Batch');
      }

      const inventoryItem = this.repository.findItemById(item.item_id);
      if (!inventoryItem) {
        throw new AppError('Inventory item was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
      }

      if (!this.repository.findWarehouseById(item.warehouse_id)) {
        throw new AppError('Warehouse was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
      }

      const quantity = toNumber(item.quantity);
      if (quantity <= 0) {
        throw new AppError('Quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
      }

      const purchaseCost = roundMoney(
        item.purchase_cost ?? item.unit_cost ?? inventoryItem.purchase_cost,
      );
      if (purchaseCost < 0) {
        throw new AppError('Purchase cost cannot be negative.', 400, 'VALIDATION_ERROR');
      }

      const sellingPrice = roundMoney(item.selling_price ?? inventoryItem.selling_price);
      if (sellingPrice < 0) {
        throw new AppError('Selling price cannot be negative.', 400, 'VALIDATION_ERROR');
      }

      const gstRate = toNumber(item.gst_rate ?? inventoryItem.gst_rate);
      if (gstRate < 0 || gstRate > 100) {
        throw new AppError('GST rate must be between 0 and 100.', 400, 'VALIDATION_ERROR');
      }

      return {
        item_id: Number(item.item_id),
        warehouse_id: Number(item.warehouse_id),
        batch_id: item.batch_id ? Number(item.batch_id) : null,
        batch_number: item.batch_number ? String(item.batch_number).trim() : null,
        manufacture_date: item.manufacture_date || null,
        expiry_date: item.expiry_date || null,
        quantity,
        purchase_cost: purchaseCost,
        selling_price: sellingPrice,
        gst_rate: gstRate,
      };
    });
  }

  /**
   * A selling price typed on a supplier bill becomes the item's price, so the
   * next job card charges what the owner just decided.
   */
  applyNewSellingPrice(item, userId) {
    const current = this.db
      .prepare('SELECT id, selling_price FROM inventory_items WHERE id = ?')
      .get(item.item_id);
    const price = roundMoney(item.selling_price);
    if (!current || !(price > 0) || roundMoney(current.selling_price) === price) return;
    this.db
      .prepare(
        'UPDATE inventory_items SET selling_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      )
      .run(price, current.id);
    this.auditRepository.create({
      userId,
      action: 'UPDATE',
      entityType: 'inventory_items',
      entityId: current.id,
      oldValue: { selling_price: current.selling_price },
      newValue: { selling_price: price, source: 'supplier bill' },
    });
  }

  createPurchaseItems({ source, sourceId, supplierId = null, items, userId = null }) {
    return items.reduce(
      (sum, item) => {
        const amounts = lineAmounts(item);
        const stockIn =
          source === 'receipt'
            ? this.inventoryService.stockIn({
                itemId: item.item_id,
                warehouseId: item.warehouse_id,
                supplierId,
                batchNumber: item.batch_number,
                manufactureDate: item.manufacture_date,
                expiryDate: item.expiry_date,
                quantity: item.quantity,
                unitCost: item.purchase_cost,
                transactionType: 'Purchase',
                referenceType: 'purchase_receipts',
                referenceId: sourceId,
                notes: 'Purchase receipt',
                userId,
              })
            : null;

        if (source === 'receipt') this.applyNewSellingPrice(item, userId);

        this.repository.createPurchaseItem({
          purchase_id: null,
          purchase_order_id: source === 'order' ? sourceId : null,
          purchase_receipt_id: source === 'receipt' ? sourceId : null,
          item_id: item.item_id,
          warehouse_id: item.warehouse_id,
          batch_id: stockIn?.batch.id || item.batch_id,
          batch_number: item.batch_number,
          manufacture_date: item.manufacture_date,
          expiry_date: item.expiry_date,
          quantity: amounts.quantity,
          purchase_cost: amounts.purchaseCost,
          selling_price: item.selling_price,
          gst_rate: amounts.gstRate,
          gst_amount: amounts.gstAmount,
          line_total: amounts.lineTotal,
        });

        return {
          subtotal: roundMoney(sum.subtotal + amounts.quantity * amounts.purchaseCost),
          gst_total: roundMoney(sum.gst_total + amounts.gstAmount),
          grand_total: roundMoney(sum.grand_total + amounts.lineTotal),
        };
      },
      { subtotal: 0, gst_total: 0, grand_total: 0 },
    );
  }

  recordSupplierLedger({
    supplierId,
    entryDate,
    entryType,
    referenceType,
    referenceId,
    debit,
    credit,
    notes,
    userId,
  }) {
    const balance = roundMoney(this.repository.latestSupplierBalance(supplierId) + credit - debit);
    this.repository.createSupplierLedger({
      supplier_id: supplierId,
      entry_date: entryDate,
      entry_type: entryType,
      reference_type: referenceType,
      reference_id: referenceId,
      debit: roundMoney(debit),
      credit: roundMoney(credit),
      balance_after: balance,
      notes,
      created_by: userId,
    });
  }

  withPagination(result, query) {
    return {
      data: result.data,
      pagination: pageInfo(query, result.total),
    };
  }
  getSupplierLedger(supplierId, query = {}) {
    const supplier = this.repository.findSupplierById(supplierId);
    if (!supplier) {
      throw new AppError('Supplier was not found.', 404, 'SUPPLIER_NOT_FOUND');
    }

    const parsed = parsePaging(query);
    const dates = {};
    for (const key of ['dateFrom', 'dateTo']) {
      if (!query[key]) continue;
      const value = String(query[key]);
      const date = new Date(`${value}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      ) {
        throw new AppError('Ledger date must be a valid YYYY-MM-DD date.', 400, 'VALIDATION_ERROR');
      }
      dates[key] = value;
    }
    if (dates.dateFrom && dates.dateTo && dates.dateFrom > dates.dateTo) {
      throw new AppError('Date range is invalid.', 400, 'VALIDATION_ERROR');
    }
    const result = this.repository.listSupplierLedger(supplierId, {
      limit: parsed.pageSize,
      offset: parsed.offset,
      ...dates,
    });

    return this.withPagination(result, parsed);
  }
}

export function createPurchasingService(db) {
  return new PurchasingService(db);
}
