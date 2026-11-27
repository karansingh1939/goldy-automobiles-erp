import { randomUUID } from 'node:crypto';
import { localDate } from '../../shared/utils/local-date.js';
import { DocumentSeries, nextDocumentNumber } from '../../shared/utils/document-number.js';
import { AppError } from '../../shared/errors/app-error.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { InventoryRepository } from './inventory.repository.js';
import { getStarterCatalog } from './starter-catalog.js';
import { AccountingPostingEngine } from '../accounting/posting-engine.service.js';
import { cashOrBankLedgerId, systemLedgerId } from '../accounting/ledgers.js';
import { toNumber, roundMoney } from '../../shared/utils/numbers.js';
import { isIsoDate, pageInfo, parsePaging, required } from '../../shared/utils/validation.js';

export class InventoryService {
  constructor(db) {
    this.db = db;
    this.repository = new InventoryRepository(db);
    this.auditRepository = new AuditRepository(db);
    this.postingEngine = new AccountingPostingEngine(db);
  }

  /** Stock can only move in or out of a godown that is switched on. */
  assertWarehousePermission(userId, warehouseId) {
    if (!userId) return; // seed scripts run without a user
    const active = this.db
      .prepare('SELECT 1 FROM warehouses WHERE id = ? AND is_active = 1')
      .get(warehouseId);
    if (!active) {
      throw new AppError(
        'This godown is switched off. Switch it on under Godowns & Masters first.',
        403,
        'PERMISSION_DENIED',
      );
    }
  }

  listItems(query) {
    const { page, pageSize } = parsePaging(query);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const categoryId =
      query.category_id === undefined || query.category_id === ''
        ? null
        : Number(query.category_id);
    if (categoryId !== null && (!Number.isSafeInteger(categoryId) || categoryId <= 0)) {
      throw new AppError('Category must be a positive integer.', 400, 'VALIDATION_ERROR');
    }
    const result = this.repository.listItems({
      search,
      categoryId,
      pageSize,
      offset: (page - 1) * pageSize,
    });

    return {
      data: result.data,
      pagination: pageInfo({ page, pageSize }, result.total),
    };
  }

  getItem(id) {
    const item = this.repository.findItemById(id);
    if (!item) {
      throw new AppError('Inventory item not found.', 404, 'ITEM_NOT_FOUND');
    }
    return item;
  }

  getItemBatches(itemId) {
    return this.repository.db
      .prepare(
        `
      SELECT b.*, w.name AS warehouse_name
      FROM inventory_batches b
      JOIN warehouses w ON b.warehouse_id = w.id
      WHERE b.item_id = ?
    `,
      )
      .all(itemId);
  }

  createItem(payload, userId) {
    let skuVal = payload.sku;
    if (skuVal === undefined || skuVal === null || String(skuVal).trim() === '') {
      skuVal = this.generateSequentialSku();
    }

    const payloadWithSku = {
      ...payload,
      sku: skuVal,
    };

    const data = this.validateItemPayload(payloadWithSku);

    return this.repository.transaction(() => {
      const item = this.repository.createItem(data);
      this.auditRepository.create({
        userId,
        action: 'CREATE',
        entityType: 'inventory_items',
        entityId: item.id,
        newValue: item,
      });
      return item;
    });
  }

  updateItem(id, payload, userId) {
    const existing = this.getItem(id);
    const data = this.validateItemPayload(payload, { partial: true });

    if (Object.keys(data).length === 0) {
      throw new AppError('At least one field is required.', 400, 'VALIDATION_ERROR');
    }

    return this.repository.transaction(() => {
      const item = this.repository.updateItem(id, data);
      this.auditRepository.create({
        userId,
        action: 'UPDATE',
        entityType: 'inventory_items',
        entityId: item.id,
        oldValue: existing,
        newValue: item,
      });
      return item;
    });
  }

  validateItemPayload(payload, { partial = false } = {}) {
    if (!partial || payload.sku !== undefined) {
      required(payload.sku, 'SKU');
      const skuVal = String(payload.sku).trim().toUpperCase();
      if (!/^[A-Z0-9_-]+$/.test(skuVal)) {
        throw new AppError('SKU must be alphanumeric.', 400, 'VALIDATION_ERROR');
      }
    }

    if (!partial || payload.item_name !== undefined || payload.itemName !== undefined) {
      required(payload.item_name ?? payload.itemName, 'Item name');
    }

    if (payload.gst_rate !== undefined) {
      const gst = toNumber(payload.gst_rate);
      if (gst < 0 || gst > 100) {
        throw new AppError('GST rate must be between 0 and 100.', 400, 'VALIDATION_ERROR');
      }
    }

    if (payload.purchase_cost !== undefined) {
      if (toNumber(payload.purchase_cost) < 0) {
        throw new AppError('Purchase cost cannot be negative.', 400, 'VALIDATION_ERROR');
      }
    }

    if (payload.selling_price !== undefined) {
      if (toNumber(payload.selling_price) < 0) {
        throw new AppError('Selling price cannot be negative.', 400, 'VALIDATION_ERROR');
      }
    }

    if (payload.reorder_level !== undefined || payload.minimum_stock !== undefined) {
      const minStock = toNumber(payload.reorder_level ?? payload.minimum_stock);
      if (minStock < 0) {
        throw new AppError('Minimum stock level cannot be negative.', 400, 'VALIDATION_ERROR');
      }
    }

    if (payload.warranty_period_months !== undefined) {
      const warranty = Number(payload.warranty_period_months);
      if (!Number.isInteger(warranty) || warranty < 0) {
        throw new AppError(
          'Warranty period must be a non-negative integer.',
          400,
          'VALIDATION_ERROR',
        );
      }
    }

    const categoryId =
      payload.category_id === undefined ? null : Number.parseInt(payload.category_id, 10);
    const supplierId =
      payload.supplier_id === undefined ? null : Number.parseInt(payload.supplier_id, 10);

    if (categoryId && !this.repository.findCategoryById(categoryId)) {
      throw new AppError('Inventory category was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    if (supplierId && !this.repository.findSupplierById(supplierId)) {
      throw new AppError('Supplier was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    const data = {};

    if (payload.sku !== undefined) data.sku = String(payload.sku).trim().toUpperCase();
    if (payload.barcode !== undefined || !partial)
      data.barcode = payload.barcode ? String(payload.barcode).trim() : null;
    if (payload.item_name !== undefined || payload.itemName !== undefined) {
      data.item_name = String(payload.item_name ?? payload.itemName).trim();
    }
    if (payload.category !== undefined || !partial)
      data.category = payload.category ? String(payload.category).trim() : null;
    if (payload.category_id !== undefined || !partial) data.category_id = categoryId || null;
    if (payload.supplier_id !== undefined || !partial) data.supplier_id = supplierId || null;
    if (payload.hsn_code !== undefined || !partial)
      data.hsn_code = payload.hsn_code ? String(payload.hsn_code).trim() : null;
    if (payload.gst_rate !== undefined || !partial)
      data.gst_rate = toNumber(payload.gst_rate !== undefined ? payload.gst_rate : 18);
    if (payload.purchase_cost !== undefined || !partial)
      data.purchase_cost = roundMoney(payload.purchase_cost);
    if (payload.selling_price !== undefined || !partial)
      data.selling_price = roundMoney(payload.selling_price);
    if (payload.reorder_level !== undefined || payload.minimum_stock !== undefined || !partial) {
      data.reorder_level = toNumber(
        payload.reorder_level !== undefined
          ? payload.reorder_level
          : payload.minimum_stock !== undefined
            ? payload.minimum_stock
            : 5,
      );
    }
    if (payload.unit_of_measure !== undefined || !partial) {
      data.unit_of_measure = payload.unit_of_measure
        ? String(payload.unit_of_measure).trim()
        : 'pcs';
    }
    if (payload.is_active !== undefined || !partial) {
      data.is_active = payload.is_active === false || payload.is_active === 0 ? 0 : 1;
    }
    if (payload.warranty_period_months !== undefined || !partial) {
      data.warranty_period_months =
        payload.warranty_period_months === undefined
          ? 0
          : Number.parseInt(payload.warranty_period_months, 10);
    }

    return data;
  }

  createOpeningStock(payload, userId) {
    required(payload.item_id, 'Item');
    required(payload.warehouse_id, 'Warehouse');

    const qty = toNumber(payload.quantity);
    if (qty <= 0) {
      throw new AppError('Quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
    }

    const unitCost = roundMoney(payload.unit_cost);
    if (unitCost < 0) {
      throw new AppError('Unit cost cannot be negative.', 400, 'VALIDATION_ERROR');
    }

    return this.repository.transaction(() => {
      const adjustmentId = this.repository.createStockAdjustment({
        adjustment_number: nextDocumentNumber(this.db, DocumentSeries.OPENING_STOCK, localDate()),
        item_id: payload.item_id,
        batch_id: null,
        warehouse_id: payload.warehouse_id,
        adjustment_type: 'OPENING',
        quantity: qty,
        unit_cost: unitCost,
        reason: payload.reason || 'Opening stock',
        created_by: userId,
      });

      const result = this.stockIn({
        itemId: payload.item_id,
        warehouseId: payload.warehouse_id,
        supplierId: payload.supplier_id || null,
        // Batch is optional for the owner; opening stock without one is "OPENING".
        batchNumber: String(payload.batch_number || '').trim() || 'OPENING',
        manufactureDate: payload.manufacture_date || null,
        expiryDate: payload.expiry_date || null,
        quantity: qty,
        unitCost: unitCost,
        transactionType: 'Opening Stock',
        referenceType: 'stock_adjustments',
        referenceId: adjustmentId,
        notes: payload.reason || 'Opening stock',
        userId,
      });

      const value = roundMoney(qty * unitCost);
      if (value > 0) {
        const voucher = this.postingEngine.post({
          companyId: 1,
          voucherType: 'Journal',
          voucherDate: payload.opening_date || localDate(),
          referenceTable: 'stock_adjustments',
          referenceId: adjustmentId,
          narration: 'Opening inventory',
          created_by: userId,
          entries: [
            {
              ledgerId: this.postingEngine.ledgerResolver.getLedgerId(1, 'inventory_stock'),
              type: 'DEBIT',
              amount: value,
            },
            {
              ledgerId: this.postingEngine.ledgerResolver.getLedgerId(1, 'capital_account'),
              type: 'CREDIT',
              amount: value,
            },
          ],
        });
        this.db
          .prepare('UPDATE stock_adjustments SET voucher_id=? WHERE id=?')
          .run(voucher.voucherId, adjustmentId);
      }

      return { adjustmentId, ...result };
    });
  }

  createAdjustment(payload, userId) {
    const itemId = Number(payload.item_id || payload.itemId);
    required(itemId, 'Item');

    const warehouseId = Number(payload.warehouse_id || payload.warehouseId || 1);
    this.assertWarehousePermission(userId, warehouseId);

    let adjustmentType = payload.adjustment_type || payload.adjustmentType;
    if (!adjustmentType && payload.action) {
      adjustmentType = String(payload.action).toUpperCase() === 'ADD' ? 'IN' : 'OUT';
    }
    required(adjustmentType, 'Adjustment type');
    adjustmentType = String(adjustmentType).toUpperCase();
    if (!['IN', 'OUT'].includes(adjustmentType)) {
      throw new AppError('Adjustment type must be IN or OUT.', 400, 'VALIDATION_ERROR');
    }

    const qty = toNumber(payload.quantity);
    if (qty <= 0) {
      throw new AppError('Quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
    }

    const category = payload.category || 'NORMAL';
    if (!['DAMAGED', 'LOST', 'EXPIRED', 'OPENING_CORRECTION', 'NORMAL'].includes(category)) {
      throw new AppError('Invalid stock adjustment category.', 400, 'VALIDATION_ERROR');
    }

    const item = this.getItem(itemId);
    const unitCost =
      payload.unit_cost !== undefined
        ? roundMoney(payload.unit_cost)
        : roundMoney(item.average_cost || item.purchase_cost || 0);

    return this.repository.transaction(() => {
      const batch =
        adjustmentType === 'IN'
          ? this.batchForAdding(item, warehouseId, payload)
          : this.batchForRemoving(item, warehouseId, payload);
      const adjustmentId = this.repository.createStockAdjustment({
        adjustment_number: nextDocumentNumber(
          this.db,
          DocumentSeries.STOCK_ADJUSTMENT,
          localDate(),
        ),
        item_id: itemId,
        batch_id: batch.id,
        warehouse_id: warehouseId,
        adjustment_type: adjustmentType,
        quantity: qty,
        unit_cost: unitCost,
        reason: payload.reason || null,
        category,
        created_by: userId,
      });
      const movement = {
        itemId,
        warehouseId,
        quantity: qty,
        transactionType: 'Adjustment',
        referenceType: 'stock_adjustments',
        referenceId: adjustmentId,
        notes: payload.reason || null,
        userId,
      };
      let stockResult;
      if (adjustmentType === 'IN') {
        stockResult = this.stockIn({
          ...movement,
          supplierId: payload.supplier_id || item.supplier_id || 1,
          batchNumber: batch.batchNumber,
          manufactureDate: payload.manufacture_date || null,
          expiryDate: payload.expiry_date || null,
          unitCost,
        });
        // A new batch only exists once the stock is in.
        if (stockResult.batch?.id && stockResult.batch.id !== batch.id)
          this.db
            .prepare('UPDATE stock_adjustments SET batch_id = ? WHERE id = ?')
            .run(stockResult.batch.id, adjustmentId);
      } else {
        stockResult = this.stockOut({ ...movement, batchId: batch.id });
      }

      // Adding stock: Stock Account up, Stock Adjustments down; removing: the reverse.
      const totalValue = roundMoney(qty * unitCost);
      const narration = `Stock Adjustment ${category}: ${item.item_name}`;
      const [debitKey, creditKey] =
        adjustmentType === 'IN'
          ? ['inventory_stock', 'stock_adjustments']
          : ['stock_adjustments', 'inventory_stock'];
      const ledger = (key) => this.postingEngine.ledgerResolver.getLedgerId(1, key);
      const voucher = this.postingEngine.post({
        companyId: 1,
        voucherType: 'Journal',
        voucherDate: localDate(),
        narration: payload.reason || `Stock Adjustment ${category} for ${item.item_name}`,
        referenceTable: 'stock_adjustments',
        referenceId: adjustmentId,
        entries: [
          { ledgerId: ledger(debitKey), type: 'DEBIT', amount: totalValue, narration },
          { ledgerId: ledger(creditKey), type: 'CREDIT', amount: totalValue, narration },
        ],
      });
      this.db
        .prepare('UPDATE stock_adjustments SET voucher_id = ? WHERE id = ?')
        .run(voucher.voucherId, adjustmentId);

      return { adjustmentId, category, voucherId: voucher.voucherId, ...stockResult };
    });
  }

  /** Batch to add stock to: the one named, else the newest in that godown, else a new "-OPEN" one. */
  batchForAdding(item, warehouseId, payload) {
    const id = payload.batch_id || payload.batchId || null;
    const batchNumber = payload.batch_number || payload.batchNumber;
    if (batchNumber) return { id, batchNumber };
    const newest = this.db
      .prepare(
        'SELECT id, batch_number FROM inventory_batches WHERE item_id = ? AND warehouse_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(item.id, warehouseId);
    return newest
      ? { id: newest.id, batchNumber: newest.batch_number }
      : { id, batchNumber: `BAT-${item.sku}-OPEN` };
  }

  /**
   * Batch to take stock from: the one named, else the oldest with stock, else
   * the newest, else an empty "-OPEN" batch (stockOut then reports no stock).
   */
  batchForRemoving(item, warehouseId, payload) {
    const id = payload.batch_id || payload.batchId;
    if (id) return { id };
    const found = this.db
      .prepare(
        `SELECT id FROM inventory_batches WHERE item_id = ? AND warehouse_id = ?
         ORDER BY quantity > 0 DESC, CASE WHEN quantity > 0 THEN id ELSE -id END LIMIT 1`,
      )
      .get(item.id, warehouseId);
    if (found) return { id: found.id };
    const created = this.repository.createBatch({
      item_id: item.id,
      warehouse_id: warehouseId,
      supplier_id: item.supplier_id || 1,
      batch_number: `BAT-${item.sku}-OPEN`,
      purchase_cost: item.purchase_cost || 0,
      selling_price: item.selling_price || 0,
      quantity: 0,
    });
    return { id: created.id };
  }

  transferStock(payload, userId) {
    required(payload.item_id, 'Item');
    required(payload.from_warehouse_id, 'From warehouse');
    required(payload.to_warehouse_id, 'To warehouse');
    required(payload.quantity, 'Quantity');

    const qty = toNumber(payload.quantity);
    if (qty <= 0) {
      throw new AppError('Quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
    }

    if (Number(payload.from_warehouse_id) === Number(payload.to_warehouse_id)) {
      throw new AppError('Warehouses must be different.', 400, 'VALIDATION_ERROR');
    }

    this.assertWarehousePermission(userId, payload.from_warehouse_id);
    this.assertWarehousePermission(userId, payload.to_warehouse_id);

    return this.repository.transaction(() => {
      const item = this.getItem(payload.item_id);
      let sourceBatch = null;

      if (payload.batch_id) {
        sourceBatch = this.repository.findBatchById(payload.batch_id);
      } else {
        // Resolve batch via FIFO
        sourceBatch = this.db
          .prepare(
            `
          SELECT * FROM inventory_batches 
          WHERE item_id = ? AND warehouse_id = ? AND quantity >= ?
          ORDER BY id ASC LIMIT 1
        `,
          )
          .get(payload.item_id, payload.from_warehouse_id, qty);
      }

      if (
        !sourceBatch ||
        Number(sourceBatch.item_id) !== Number(payload.item_id) ||
        Number(sourceBatch.warehouse_id) !== Number(payload.from_warehouse_id)
      ) {
        throw new AppError(
          'No suitable batch found in the source warehouse with enough stock.',
          400,
          'RELATED_RECORD_NOT_FOUND',
        );
      }

      const transferId = this.repository.createStockTransfer({
        transfer_number: nextDocumentNumber(this.db, DocumentSeries.STOCK_MOVE, localDate()),
        item_id: payload.item_id,
        batch_id: sourceBatch.id,
        from_warehouse_id: payload.from_warehouse_id,
        to_warehouse_id: payload.to_warehouse_id,
        quantity: qty,
        shipped_quantity: qty,
        received_quantity: null,
        unit_cost: roundMoney(item.average_cost || sourceBatch.purchase_cost),
        status: 'PENDING',
        notes: payload.notes || null,
        created_by: userId,
      });

      const out = this.stockOut({
        itemId: payload.item_id,
        warehouseId: payload.from_warehouse_id,
        batchId: sourceBatch.id,
        quantity: qty,
        transactionType: 'Transfer',
        referenceType: 'stock_transfers',
        referenceId: transferId,
        notes: payload.notes || null,
        userId,
      });

      // One workshop, one person: a move between godowns arrives at once.
      // (There is no separate "receive" step on any screen.)
      const received = this.receiveTransfer(transferId, userId);
      return {
        ...received,
        transferId,
        transferNumber: this.db
          .prepare('SELECT transfer_number FROM stock_transfers WHERE id = ?')
          .get(transferId).transfer_number,
        out,
      };
    });
  }

  /** Puts moved stock into the destination godown and marks the move complete. */
  receiveTransfer(transferId, userId) {
    const transfer = this.db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(transferId);
    this.assertWarehousePermission(userId, transfer.to_warehouse_id);
    const sourceBatch = this.repository.findBatchById(transfer.batch_id);
    const into = this.stockIn({
      itemId: transfer.item_id,
      warehouseId: transfer.to_warehouse_id,
      supplierId: sourceBatch.supplier_id,
      batchNumber: sourceBatch.batch_number,
      manufactureDate: sourceBatch.manufacture_date,
      expiryDate: sourceBatch.expiry_date,
      quantity: transfer.quantity,
      unitCost: transfer.unit_cost,
      transactionType: 'Transfer',
      referenceType: 'stock_transfers',
      referenceId: transferId,
      notes: transfer.notes || null,
      userId,
      keepAverageCost: true,
    });
    this.db
      .prepare(
        `UPDATE stock_transfers
         SET status = 'COMPLETED', received_quantity = quantity, received_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(transferId);
    return { transferId, status: 'COMPLETED', receivedQuantity: transfer.quantity, in: into };
  }

  /** Stock on hand for an item, optionally in one godown or one batch. */
  getAvailableQuantity(itemId, warehouseId = null, batchId = null) {
    let physicalQty = 0;
    if (batchId) {
      const batch = this.repository.findBatchById(batchId);
      physicalQty = batch ? toNumber(batch.quantity) : 0;
    } else if (warehouseId) {
      const row = this.db
        .prepare(
          'SELECT SUM(quantity) AS total FROM inventory_batches WHERE item_id = ? AND warehouse_id = ?',
        )
        .get(itemId, warehouseId);
      physicalQty = toNumber(row?.total);
    } else {
      const item = this.repository.findItemById(itemId);
      physicalQty = item ? toNumber(item.current_quantity) : 0;
    }

    return Math.max(0, physicalQty);
  }

  stockIn({
    itemId,
    warehouseId,
    supplierId = null,
    batchNumber,
    manufactureDate = null,
    expiryDate = null,
    quantity,
    unitCost,
    transactionType,
    referenceType,
    referenceId,
    notes = null,
    userId,
    keepAverageCost = false,
  }) {
    required(itemId, 'Item');
    required(warehouseId, 'Warehouse');
    required(batchNumber, 'Batch number');

    const qty = toNumber(quantity);
    const cost = roundMoney(unitCost);

    if (qty <= 0) {
      throw new AppError('Quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
    }

    this.assertWarehousePermission(userId, warehouseId);

    const item = this.getItem(itemId);
    if (!this.repository.findWarehouseById(warehouseId)) {
      throw new AppError('Warehouse was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    let batch = this.repository.findBatchByNumber({ itemId, warehouseId, batchNumber });
    if (!batch) {
      batch = this.repository.createBatch({
        item_id: itemId,
        warehouse_id: warehouseId,
        supplier_id: supplierId || item.supplier_id,
        batch_number: String(batchNumber).trim(),
        purchase_cost: cost,
        selling_price: item.selling_price,
        quantity: 0,
        manufacture_date: manufactureDate,
        expiry_date: expiryDate,
      });
    }

    const oldQty = toNumber(item.current_quantity);
    const oldAverageCost = roundMoney(item.average_cost);
    const newQty = oldQty + qty;
    const newAverageCost = keepAverageCost
      ? oldAverageCost
      : roundMoney(newQty === 0 ? 0 : (oldQty * oldAverageCost + qty * cost) / newQty);

    const updatedBatch = this.repository.updateBatchQuantity(
      batch.id,
      toNumber(batch.quantity) + qty,
    );
    const updatedItem = this.repository.updateItemStock({
      itemId,
      quantity: newQty,
      averageCost: newAverageCost,
    });

    this.repository.createInventoryTransaction({
      item_id: itemId,
      batch_id: updatedBatch.id,
      warehouse_id: warehouseId,
      transaction_type: transactionType,
      direction: 'IN',
      reference_type: referenceType,
      reference_id: referenceId,
      quantity: qty,
      unit_cost: cost,
      average_cost_after: updatedItem.average_cost,
      quantity_after: updatedItem.current_quantity,
      notes,
      created_by: userId,
    });

    return {
      item: updatedItem,
      batch: updatedBatch,
      quantity: qty,
      unitCost: cost,
      averageCostAfter: updatedItem.average_cost,
    };
  }

  stockOut({
    itemId,
    warehouseId,
    batchId,
    quantity,
    transactionType,
    referenceType,
    referenceId,
    notes = null,
    userId,
    unitCost,
    deferPurchaseValuation = false,
  }) {
    required(itemId, 'Item');
    required(warehouseId, 'Warehouse');
    required(batchId, 'Batch');

    const qty = toNumber(quantity);
    if (qty <= 0) {
      throw new AppError('Quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
    }

    this.assertWarehousePermission(userId, warehouseId);

    const item = this.getItem(itemId);
    const batch = this.repository.findBatchById(batchId);

    if (
      !batch ||
      Number(batch.item_id) !== Number(itemId) ||
      Number(batch.warehouse_id) !== Number(warehouseId)
    ) {
      throw new AppError(
        'Batch was not found in the selected warehouse.',
        400,
        'RELATED_RECORD_NOT_FOUND',
      );
    }

    const available = this.getAvailableQuantity(itemId, warehouseId, batchId);
    if (available < qty) {
      throw new AppError('Insufficient available stock.', 400, 'INSUFFICIENT_STOCK');
    }

    const cost = unitCost === undefined ? roundMoney(item.average_cost) : roundMoney(unitCost);
    const newQty = toNumber(item.current_quantity) - qty;
    const remainingValue = roundMoney(
      toNumber(item.current_quantity) * roundMoney(item.average_cost) - qty * cost,
    );
    if (
      unitCost !== undefined &&
      !deferPurchaseValuation &&
      (remainingValue < -0.01 || (newQty === 0 && Math.abs(remainingValue) > 0.01))
    ) {
      throw new AppError(
        'Purchase cannot be reversed after its stock valuation has been consumed. Use a supplier return.',
        409,
        'PURCHASE_VALUATION_CONFLICT',
      );
    }
    const averageCost =
      unitCost === undefined || deferPurchaseValuation
        ? roundMoney(item.average_cost)
        : roundMoney(newQty > 0 ? Math.max(0, remainingValue) / newQty : 0);
    const updatedBatch = this.repository.updateBatchQuantity(
      batch.id,
      toNumber(batch.quantity) - qty,
    );
    const updatedItem = this.repository.updateItemStock({
      itemId,
      quantity: newQty,
      averageCost,
    });

    this.repository.createInventoryTransaction({
      item_id: itemId,
      batch_id: batchId,
      warehouse_id: warehouseId,
      transaction_type: transactionType,
      direction: 'OUT',
      reference_type: referenceType,
      reference_id: referenceId,
      quantity: qty,
      unit_cost: cost,
      average_cost_after: updatedItem.average_cost,
      quantity_after: updatedItem.current_quantity,
      notes,
      created_by: userId,
    });

    return {
      item: updatedItem,
      batch: updatedBatch,
      quantity: qty,
      unitCost: cost,
      averageCostAfter: updatedItem.average_cost,
    };
  }

  stockSummary() {
    return { data: this.repository.stockSummary() };
  }

  /**
   * Stock value per item at weighted average cost, the same method as the
   * accounts, optionally as at the end of a past day (rebuilt from movements).
   */
  stockValuation(query = {}) {
    const method = String(query.method || 'AVCO').toUpperCase();
    if (method !== 'AVCO')
      throw new AppError(
        'Stock is valued at weighted average cost (AVCO), the same as the accounts.',
        400,
        'VALIDATION_ERROR',
      );
    const date = query.date ? String(query.date).trim() : null;
    if (date && !isIsoDate(date))
      throw new AppError('Invalid date format. Expected YYYY-MM-DD.', 400, 'VALIDATION_ERROR');
    // Movements are stamped in UTC; the end of the laptop's day in UTC keeps the index usable.
    const until = date
      ? new Date(`${date}T23:59:59.999`).toISOString().slice(0, 19).replace('T', ' ')
      : null;

    const items = this.db
      .prepare(
        'SELECT id, sku, item_name, purchase_cost, average_cost FROM inventory_items WHERE is_active = 1',
      )
      .all();
    const movements = Map.groupBy(
      this.db
        .prepare(
          `SELECT item_id, direction, quantity, unit_cost FROM inventory_transactions
           ${until ? 'WHERE created_at <= ?' : ''} ORDER BY item_id, id`,
        )
        .all(...(until ? [until] : [])),
      (row) => row.item_id,
    );
    const batchStock = new Map(
      this.db
        .prepare('SELECT item_id, SUM(quantity) AS total FROM inventory_batches GROUP BY item_id')
        .all()
        .map((row) => [row.item_id, toNumber(row.total)]),
    );

    const data = items.map((item) => {
      const txs = movements.get(item.id) || [];
      let quantity = 0;
      let averageCost = toNumber(item.purchase_cost || item.average_cost || 0);
      for (const tx of txs) {
        const qty = toNumber(tx.quantity);
        if (tx.direction === 'IN') {
          if (quantity + qty > 0)
            averageCost =
              (quantity * averageCost + qty * toNumber(tx.unit_cost)) / (quantity + qty);
          quantity += qty;
        } else {
          quantity = Math.max(0, quantity - qty);
        }
      }
      // Stock entered before movements were recorded has no history yet.
      if (!txs.length && !until) quantity = batchStock.get(item.id) || 0;
      const cost = roundMoney(averageCost);
      return {
        id: item.id,
        sku: item.sku,
        item_name: item.item_name,
        current_quantity: quantity,
        average_cost: cost,
        stock_value: roundMoney(quantity * cost),
      };
    });

    return {
      data,
      totals: {
        quantity: data.reduce((sum, row) => sum + row.current_quantity, 0),
        value: roundMoney(data.reduce((sum, row) => sum + row.stock_value, 0)),
      },
    };
  }

  movementReport(query = {}) {
    return { data: this.repository.inventoryMovements({ itemId: query.itemId }) };
  }

  lowStockReport() {
    return { data: this.repository.lowStock() };
  }

  /** True once the starter catalogue was loaded, or when items already exist. */
  starterLoaded() {
    const flag = this.db
      .prepare("SELECT value FROM system_settings WHERE key = 'inventory.starter_loaded'")
      .get();
    return (
      flag?.value === 'true' ||
      this.db.prepare('SELECT 1 FROM inventory_items LIMIT 1').get() !== undefined
    );
  }

  getSeedStatus() {
    return { loaded: this.starterLoaded() };
  }

  /** Adds the starter parts catalogue (zero stock) once, for a new workshop. */
  seedStarter() {
    const markLoaded = () =>
      this.db
        .prepare(
          "INSERT OR IGNORE INTO system_settings (key, value) VALUES ('inventory.starter_loaded', 'true')",
        )
        .run();
    if (this.starterLoaded()) {
      markLoaded();
      return { loaded: true, itemsSeeded: 0, message: 'Starter inventory already loaded.' };
    }

    const catalog = getStarterCatalog();

    // Run everything in a transaction!
    return this.repository.transaction(() => {
      // 4. Ensure we have an active warehouse
      let warehouse = this.db
        .prepare('SELECT id FROM warehouses WHERE is_active = 1 LIMIT 1')
        .get();
      if (!warehouse) {
        const whId = this.db
          .prepare(
            "INSERT INTO warehouses (name, code, address, is_active) VALUES ('Main Godown', 'GMAIN', 'Primary Workshop Warehouse', 1)",
          )
          .run().lastInsertRowid;
        warehouse = { id: whId };
      }

      // 5. Ensure we have suppliers: Garg Traders and Hari Om Traders.
      // Contact details and GSTINs are left empty so no invented phone numbers,
      // emails or tax IDs enter the live workshop database or GST reports; the
      // workshop fills in real details from the suppliers screen.
      const insertSupplier = this.db.prepare(`
        INSERT OR IGNORE INTO suppliers (name, phone, email, address, gstin, is_active)
        VALUES (?, NULL, NULL, NULL, NULL, 1)
      `);
      insertSupplier.run('Garg Traders');
      insertSupplier.run('Hari Om Traders');

      const supplierGarg = this.db
        .prepare("SELECT id FROM suppliers WHERE name = 'Garg Traders'")
        .get();
      const supplierHariOm = this.db
        .prepare("SELECT id FROM suppliers WHERE name = 'Hari Om Traders'")
        .get();
      const defaultSupplier = supplierGarg || supplierHariOm || { id: 1 };

      // Ensure categories exist in inventory_categories
      const categoriesMap = {};
      const insertCategoryStmt = this.db.prepare(
        'INSERT OR IGNORE INTO inventory_categories (name, description, is_active) VALUES (?, ?, 1)',
      );
      const getCategoryStmt = this.db.prepare('SELECT id FROM inventory_categories WHERE name = ?');

      const uniqueCategories = [...new Set(catalog.map((item) => item.category))];
      for (const catName of uniqueCategories) {
        insertCategoryStmt.run(catName, `${catName} starter category`);
        const row = getCategoryStmt.get(catName);
        if (row) {
          categoriesMap[catName] = row.id;
        }
      }

      let seededCount = 0;
      const seenSkus = new Set();
      const itemExists = this.db.prepare('SELECT 1 FROM inventory_items WHERE sku = ?');
      for (const item of catalog) {
        if (seenSkus.has(item.sku)) {
          continue;
        }

        if (itemExists.get(item.sku)) {
          seenSkus.add(item.sku);
          continue;
        }

        const supplierId =
          seededCount % 2 === 0 && supplierHariOm ? supplierHariOm.id : defaultSupplier.id;
        const itemPayload = {
          sku: item.sku,
          barcode: null,
          item_name: item.itemName,
          category: item.category,
          category_id: categoriesMap[item.category] || null,
          supplier_id: supplierId,
          hsn_code: item.hsn || '8708',
          hsn_sac_code: item.hsn || '8708',
          gst_rate: item.gstRate,
          purchase_cost: item.purchaseCost,
          average_cost: 0,
          selling_price: item.sellingPrice,
          minimum_stock: item.minimumStock,
          reorder_level: item.reorderLevel,
          unit_of_measure: item.unit,
          is_active: 1,
        };

        this.repository.createItem(itemPayload);
        seenSkus.add(item.sku);

        seededCount++;
      }

      markLoaded();

      return {
        loaded: true,
        message: 'Starter inventory catalog loaded successfully.',
        itemsSeeded: seededCount,
      };
    });
  }

  listFixedAssets(query) {
    const paging = parsePaging(query);
    const result = this.repository.listFixedAssets(paging);
    return { data: result.data, pagination: pageInfo(paging, result.total) };
  }

  /**
   * Registers workshop equipment (not stock for sale). Only the name, date and
   * price are needed; a code is made up when left blank. The money side is
   * posted at once: paid from Cash, from a bank account, or bought before
   * using this app (then it is added to the owner's capital).
   */
  createFixedAsset(payload, userId) {
    required(payload.asset_name, 'Equipment name');
    required(payload.purchase_date, 'Date bought');
    required(payload.purchase_cost, 'Price');

    let sku = payload.sku ? String(payload.sku).trim().toUpperCase() : '';
    if (sku && !/^[A-Z0-9_-]+$/.test(sku)) {
      throw new AppError('Code can only have letters, numbers, - and _.', 400, 'VALIDATION_ERROR');
    }

    let supplierId = null;
    if (payload.supplier_id) {
      supplierId = Number.parseInt(payload.supplier_id, 10);
      if (!this.repository.findSupplierById(supplierId)) {
        throw new AppError('Supplier was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
      }
    }

    const cost = roundMoney(payload.purchase_cost);
    const gstAmount = roundMoney(payload.gst_amount || 0);
    if (!(cost >= 0) || !(gstAmount >= 0)) {
      throw new AppError('Price and GST cannot be below zero.', 400, 'VALIDATION_ERROR');
    }

    const paidFrom = String(payload.paid_from || 'CASH').toUpperCase();
    if (!['CASH', 'BANK', 'EARLIER'].includes(paidFrom)) {
      throw new AppError('Choose how it was paid.', 400, 'VALIDATION_ERROR');
    }

    const text = (value) => (value ? String(value).trim() : null);

    return this.repository.transaction(() => {
      if (!sku) {
        let next = this.db.prepare('SELECT COUNT(*) AS n FROM fixed_assets').get().n + 1;
        sku = `FA-${String(next).padStart(4, '0')}`;
        while (this.db.prepare('SELECT 1 FROM fixed_assets WHERE sku = ?').get(sku)) {
          next += 1;
          sku = `FA-${String(next).padStart(4, '0')}`;
        }
      }
      const created = this.repository.createFixedAsset({
        asset_name: String(payload.asset_name).trim(),
        sku,
        category: text(payload.category) || 'Equipment',
        supplier_id: supplierId,
        invoice_number: text(payload.invoice_number),
        purchase_date: String(payload.purchase_date).trim(),
        purchase_cost: cost,
        gst_amount: gstAmount,
        serial_number: text(payload.serial_number),
        warranty_info: text(payload.warranty_info),
        notes: text(payload.notes),
        paid_from: paidFrom,
        created_by: userId,
      });

      const total = roundMoney(cost + gstAmount);
      if (total > 0) {
        const voucher = this.postingEngine.post({
          companyId: 1,
          voucherType: paidFrom === 'EARLIER' ? 'Journal' : 'Payment',
          // Old equipment may predate every financial year in the app, so it
          // joins the books today; the record keeps its real purchase date.
          voucherDate: paidFrom === 'EARLIER' ? localDate() : created.purchase_date,
          referenceTable: 'fixed_assets',
          referenceId: created.id,
          narration: `Equipment bought: ${created.asset_name}${paidFrom === 'EARLIER' ? ' (bought earlier)' : ''}`,
          created_by: userId,
          entries: [
            {
              ledgerId: systemLedgerId(this.db, 'workshop_equipment'),
              type: 'DEBIT',
              amount: total,
            },
            {
              ledgerId: this.assetPaymentLedgerId(paidFrom, payload.payment_account_id),
              type: 'CREDIT',
              amount: total,
            },
          ],
        });
        this.db
          .prepare('UPDATE fixed_assets SET voucher_id = ? WHERE id = ?')
          .run(voucher.voucherId, created.id);
      }

      const asset = this.repository.findFixedAssetById(created.id);
      this.auditRepository.create({
        userId,
        action: 'CREATE',
        entityType: 'fixed_assets',
        entityId: asset.id,
        newValue: asset,
      });
      return asset;
    });
  }

  /** Wrongly entered equipment is cancelled and its money entry reversed. */
  cancelFixedAsset(id, userId) {
    const asset = this.repository.findFixedAssetById(Number(id));
    if (!asset) throw new AppError('Equipment not found.', 404, 'NOT_FOUND');
    if (asset.status === 'CANCELLED') {
      throw new AppError('This equipment is already cancelled.', 400, 'ALREADY_CANCELLED');
    }
    return this.repository.transaction(() => {
      if (asset.voucher_id) this.postingEngine.deleteVoucher(1, asset.voucher_id);
      this.db
        .prepare(
          "UPDATE fixed_assets SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(asset.id);
      this.auditRepository.create({
        userId,
        action: 'CANCEL',
        entityType: 'fixed_assets',
        entityId: asset.id,
        oldValue: asset,
      });
      return this.repository.findFixedAssetById(asset.id);
    });
  }

  /** Cash, the chosen (or only) bank account, or capital for equipment bought earlier. */
  assetPaymentLedgerId(paidFrom, accountId) {
    if (paidFrom === 'EARLIER') return systemLedgerId(this.db, 'capital_account');
    return cashOrBankLedgerId(this.db, {
      cash: paidFrom === 'CASH',
      bankId: accountId,
      message: 'Choose which bank account paid for it.',
    });
  }

  listStockVerifications(query) {
    const { page, pageSize } = parsePaging(query);
    const result = this.repository.listStockVerifications({
      limit: pageSize,
      offset: (page - 1) * pageSize,
      warehouseId: query.warehouseId ? Number(query.warehouseId) : null,
      itemId: query.itemId ? Number(query.itemId) : null,
      batchId: query.batchId ? Number(query.batchId) : null,
    });

    return {
      data: result.data,
      pagination: pageInfo({ page, pageSize }, result.total),
    };
  }

  verifyStock(payload, userId) {
    const verifications = Array.isArray(payload.verifications) ? payload.verifications : [payload];
    const verificationType = payload.verification_type || 'Single Item';
    const auditSessionId = payload.audit_session_id || randomUUID();

    if (verifications.length === 0) {
      throw new AppError('At least one verification item is required.', 400, 'VALIDATION_ERROR');
    }

    const godownStock = this.db.prepare(
      'SELECT SUM(quantity) AS total FROM inventory_batches WHERE item_id = ? AND warehouse_id = ?',
    );
    const insertCount = this.db.prepare(
      `INSERT INTO stock_verifications (
         verification_number, verification_type, audit_session_id, warehouse_id,
         item_id, batch_id, previous_quantity, counted_quantity, difference,
         status, verified_by, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    );
    return this.repository.transaction(() => {
      const results = [];

      for (const ver of verifications) {
        const warehouseId = Number(ver.warehouse_id || 1);
        required(ver.item_id, 'Item');
        required(ver.counted_quantity, 'Counted quantity');

        const itemId = Number(ver.item_id);
        const countedQty = toNumber(ver.counted_quantity);

        if (countedQty < 0) {
          throw new AppError('Counted quantity cannot be negative.', 400, 'VALIDATION_ERROR');
        }

        const item = this.repository.findItemById(itemId);
        if (!item) {
          throw new AppError(`Item ID ${itemId} not found.`, 404, 'ITEM_NOT_FOUND');
        }

        const warehouse = this.repository.findWarehouseById(warehouseId);
        if (!warehouse) {
          throw new AppError(`Warehouse ID ${warehouseId} not found.`, 404, 'WAREHOUSE_NOT_FOUND');
        }

        this.assertWarehousePermission(userId, warehouseId);

        let previousQty = 0;
        let batchId = ver.batch_id ? Number(ver.batch_id) : null;

        if (batchId) {
          const batch = this.repository.findBatchById(batchId);
          if (
            !batch ||
            Number(batch.item_id) !== itemId ||
            Number(batch.warehouse_id) !== warehouseId
          ) {
            throw new AppError(
              'Batch was not found in the selected warehouse.',
              400,
              'RELATED_RECORD_NOT_FOUND',
            );
          }
          previousQty = toNumber(batch.quantity);
        } else {
          previousQty = toNumber(godownStock.get(itemId, warehouseId)?.total);
        }

        const difference = countedQty - previousQty;
        const verificationNumber = nextDocumentNumber(
          this.db,
          DocumentSeries.STOCK_COUNT,
          localDate(),
        );

        insertCount.run(
          verificationNumber,
          verificationType,
          auditSessionId,
          warehouseId,
          itemId,
          batchId,
          previousQty,
          countedQty,
          difference,
          userId,
          ver.notes || null,
        );

        results.push({
          verification_number: verificationNumber,
          item_name: item.item_name,
          sku: item.sku,
          previous_quantity: previousQty,
          counted_quantity: countedQty,
          difference: difference,
          status: 'PENDING',
        });
      }

      return {
        audit_session_id: auditSessionId,
        verification_type: verificationType,
        items: results,
      };
    });
  }

  /** A stock count that is still waiting for approval, in a godown that is switched on. */
  pendingVerification(verificationId, userId) {
    const ver = this.db
      .prepare('SELECT * FROM stock_verifications WHERE id = ?')
      .get(verificationId);
    if (!ver) throw new AppError('Verification record not found.', 404, 'VERIFICATION_NOT_FOUND');
    if (ver.status !== 'PENDING')
      throw new AppError(
        `Verification has already been processed (status: ${ver.status}).`,
        400,
        'VALIDATION_ERROR',
      );
    this.assertWarehousePermission(userId, ver.warehouse_id);
    return ver;
  }

  approveVerification(verificationId, userId) {
    return this.repository.transaction(() => {
      const ver = this.pendingVerification(verificationId, userId);
      let adjustmentId = null;
      if (ver.difference !== 0) {
        const adjResult = this.createAdjustment(
          {
            itemId: ver.item_id,
            warehouseId: ver.warehouse_id,
            batchId: ver.batch_id,
            quantity: Math.abs(ver.difference),
            adjustmentType: ver.difference > 0 ? 'IN' : 'OUT',
            category: 'NORMAL',
            reason: `Physical count verification ${ver.verification_number} variance`,
          },
          userId,
        );
        adjustmentId = adjResult.adjustmentId;
      }

      this.db
        .prepare(
          `
        UPDATE stock_verifications 
        SET status = 'APPROVED', approved_by = ?, approved_at = CURRENT_TIMESTAMP, adjustment_id = ?
        WHERE id = ?
      `,
        )
        .run(userId, adjustmentId, verificationId);

      return {
        id: verificationId,
        status: 'APPROVED',
        adjustmentId,
      };
    });
  }

  rejectVerification(verificationId, userId) {
    return this.repository.transaction(() => {
      this.pendingVerification(verificationId, userId);
      this.db
        .prepare(
          `
        UPDATE stock_verifications 
        SET status = 'REJECTED', approved_by = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        )
        .run(userId, verificationId);

      return {
        id: verificationId,
        status: 'REJECTED',
      };
    });
  }

  dashboardStats() {
    const stats = this.db
      .prepare(
        `
      SELECT 
        COUNT(*) AS totalItems,
        SUM(current_quantity * average_cost) AS totalValue,
        -- Count only items the workshop has actually bought; the starter catalogue
        -- of never-stocked items is not "low" or "out of stock".
        SUM(CASE WHEN bought AND reorder_level > 0 AND current_quantity <= reorder_level
          THEN 1 ELSE 0 END) AS lowStockCount,
        SUM(CASE WHEN bought AND current_quantity <= 0 THEN 1 ELSE 0 END) AS outOfStockCount
      FROM (
        SELECT inventory_items.*,
          EXISTS (SELECT 1 FROM inventory_batches b WHERE b.item_id = inventory_items.id) AS bought
        FROM inventory_items
        WHERE is_active = 1
      )
    `,
      )
      .get();

    return {
      totalItems: stats.totalItems || 0,
      totalValue: roundMoney(stats.totalValue || 0),
      lowStockCount: stats.lowStockCount || 0,
      outOfStockCount: stats.outOfStockCount || 0,
    };
  }

  bulkSave(payload, userId) {
    const items = Array.isArray(payload) ? payload : payload.items || [];
    if (items.length === 0) {
      throw new AppError('At least one item is required.', 400, 'VALIDATION_ERROR');
    }

    // Counts go into the main godown, through the same opening-stock and
    // adjustment steps as single entries, so the accounts move with the stock.
    const godown = this.db
      .prepare(
        "SELECT id FROM warehouses WHERE is_active = 1 ORDER BY is_default DESC, code = 'MAIN' DESC, id LIMIT 1",
      )
      .get()?.id;
    if (!godown) throw new AppError('Add a godown first.', 400, 'WAREHOUSE_REQUIRED');

    return this.repository.transaction(() => {
      for (const entry of items) {
        const itemId = Number(entry.itemId ?? entry.item_id);
        const quantity = toNumber(entry.quantity);
        const unitCost = entry.unitCost ?? entry.unit_cost;
        if (!itemId) {
          throw new AppError('Item ID is required for all entries.', 400, 'VALIDATION_ERROR');
        }
        if (quantity < 0) {
          throw new AppError('Quantity cannot be negative.', 400, 'VALIDATION_ERROR');
        }
        const item = this.repository.findItemById(itemId);
        if (!item) {
          throw new AppError(`Item ID ${itemId} not found.`, 404, 'ITEM_NOT_FOUND');
        }
        const diff = roundMoney(quantity - toNumber(item.current_quantity));
        if (diff > 0) {
          this.createOpeningStock(
            {
              item_id: itemId,
              warehouse_id: godown,
              quantity: diff,
              unit_cost:
                unitCost !== undefined ? unitCost : item.average_cost || item.purchase_cost || 0,
              batch_number: `${item.sku}-OPEN`,
            },
            userId,
          );
        } else if (diff < 0) {
          this.createAdjustment(
            {
              item_id: itemId,
              warehouse_id: godown,
              adjustment_type: 'OUT',
              quantity: Math.abs(diff),
              category: 'OPENING_CORRECTION',
              reason: 'Stock count correction',
            },
            userId,
          );
        }
      }
      return { success: true };
    });
  }

  /** Next free automatic item code: ITM-00001, ITM-00002, ... */
  generateSequentialSku() {
    const highest = this.db
      .prepare("SELECT sku FROM inventory_items WHERE sku LIKE 'ITM-%'")
      .all()
      .reduce((max, { sku }) => Math.max(max, Number(/^ITM-(\d+)$/.exec(sku)?.[1] ?? 0)), 0);
    return `ITM-${String(highest + 1).padStart(5, '0')}`;
  }
}

export function createInventoryService(db) {
  return new InventoryService(db);
}
