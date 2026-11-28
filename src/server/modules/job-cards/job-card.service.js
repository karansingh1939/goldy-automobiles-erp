import { assertCustomerCreditLimit } from '../accounting/customer-credit.service.js';
import { addMonths, localDate } from '../../shared/utils/local-date.js';
import { DocumentSeries, nextDocumentNumber } from '../../shared/utils/document-number.js';
import { AppError } from '../../shared/errors/app-error.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { JobCardRepository } from './job-card.repository.js';
import { AccountingPostingEngine } from '../accounting/posting-engine.service.js';
import { releaseDocumentAllocations } from '../accounting/allocation.service.js';
import { taxLines, withRoundOff } from '../accounting/ledgers.js';
import { isInterstate } from '../settings/company-settings.js';
import { toNumber, roundMoney } from '../../shared/utils/numbers.js';
import { pageInfo, parsePaging, required } from '../../shared/utils/validation.js';
import { IntakeLookupService, localPhone, normalizeRegistration } from './intake-lookup.service.js';

function parseListQuery(query) {
  return {
    ...parsePaging(query),
    status: typeof query.status === 'string' ? query.status.trim() : '',
    fromDate: typeof query.fromDate === 'string' ? query.fromDate.trim() : '',
    toDate: typeof query.toDate === 'string' ? query.toDate.trim() : '',
    exactMatchOnly: query.exactMatchOnly === 'true',
  };
}

const sum = (rows, value) => rows.reduce((total, row) => total + value(row), 0);

function gstAmounts(revenue, gstRate, interstate = false) {
  const gstTotal = roundMoney((revenue * toNumber(gstRate)) / 100);
  const half = roundMoney(gstTotal / 2);
  return {
    cgst: interstate ? 0 : half,
    sgst: interstate ? 0 : roundMoney(gstTotal - half),
    igst: interstate ? gstTotal : 0,
    gstTotal,
  };
}

export class JobCardService {
  constructor(db) {
    this.db = db;
    this.repository = new JobCardRepository(db);
    this.inventoryService = new InventoryService(db);
    this.auditRepository = new AuditRepository(db);
    this.postingEngine = new AccountingPostingEngine(db);
    this.lookups = new IntakeLookupService(db);
  }

  list(query = {}) {
    const parsed = parseListQuery(query);
    const result = this.repository.listJobCards(parsed);

    return {
      data: result.data,
      pagination: {
        ...pageInfo(parsed, result.total),
        unfilteredTotal: result.unfilteredTotal,
        matchType: result.matchType || '',
        matchValue: result.matchValue || '',
      },
    };
  }

  get(id) {
    const jobCard = this.repository.findJobCardById(id);
    if (!jobCard) {
      throw new AppError('Job card not found.', 404, 'JOB_CARD_NOT_FOUND');
    }

    const previousVisitsCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM job_cards WHERE customer_id = ? AND id != ?')
      .get(jobCard.customer_id, id).count;

    return {
      ...jobCard,
      previous_visits_count: previousVisitsCount,
      parts: this.repository.listParts(id),
      labour: this.repository.listLabour(id),
      invoice: this.repository.findInvoiceByJobCardId(id) || null,
    };
  }

  create(payload, userId) {
    return this.repository.transaction(() => this.createIntake(payload, userId));
  }

  createIntake(payload, userId) {
    let customerId = payload.customer_id;
    let vehicleId = payload.vehicle_id;

    if (!customerId || !vehicleId) {
      required(payload.registration_number, 'Registration Number');
      required(payload.customer_name, 'Customer Name');
      const regNormalized = normalizeRegistration(payload.registration_number);
      if (regNormalized.length < 4)
        throw new AppError(
          'Registration number must be at least 4 alphanumeric characters.',
          400,
          'VALIDATION_ERROR',
        );
      let phone = null;
      if (payload.phone) {
        phone = localPhone(payload.phone);
        if (phone.length !== 10)
          throw new AppError('Phone number must be exactly 10 digits.', 400, 'VALIDATION_ERROR');
      }

      const vehicle = this.lookups.vehicleRow(regNormalized);
      let customer = payload.customer_id
        ? this.db.prepare('SELECT * FROM customers WHERE id = ?').get(payload.customer_id)
        : null;
      if (payload.customer_id && !customer && vehicle)
        throw new AppError('Customer was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
      if (!customer && phone) customer = this.lookups.customerRowByPhone(phone);

      if (customer) {
        customerId = customer.id;
        this.updateChanged('customers', customer, payload, ['name', 'address', 'city', 'notes']);
      } else {
        // The name is required, so an unknown phone means a new customer.
        customerId = this.db
          .prepare(
            `INSERT INTO customers (name, phone, address, city, notes, state)
             VALUES (?, ?, ?, ?, ?, 'Haryana')`,
          )
          .run(
            payload.customer_name,
            phone,
            payload.address || null,
            payload.city || null,
            payload.notes || null,
          ).lastInsertRowid;
      }

      if (vehicle) {
        vehicleId = vehicle.id;
        this.updateChanged('vehicles', vehicle, payload, [
          'make',
          'model',
          'fuel_type',
          'chassis_number',
          'engine_number',
        ]);
      } else {
        vehicleId = this.db
          .prepare(
            `INSERT INTO vehicles (customer_id, registration_number, registration_number_normalized,
               make, model, fuel_type, chassis_number, engine_number, odometer_reading)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            customerId,
            String(payload.registration_number).trim().toUpperCase(),
            regNormalized,
            payload.make || null,
            payload.model || null,
            payload.fuel_type || null,
            payload.chassis_number || null,
            payload.engine_number || null,
            Number(payload.odometer_reading),
          ).lastInsertRowid;
      }
    }

    const customer = this.repository.findCustomerById(customerId);
    if (!customer) {
      throw new AppError('Customer was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    const vehicle = this.repository.findVehicleById(vehicleId);
    if (!vehicle) {
      throw new AppError('Vehicle was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    // Handle explicit ownership transfer if vehicle already existed and is different from the job card customer
    if (payload.transfer_ownership && Number(vehicle.customer_id) !== Number(customer.id)) {
      this.db
        .prepare('UPDATE vehicles SET customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(customer.id, vehicle.id);
      this.auditRepository.create({
        userId,
        action: 'UPDATE',
        entityType: 'vehicles',
        entityId: vehicle.id,
        oldValue: { customer_id: vehicle.customer_id },
        newValue: { customer_id: customer.id },
      });
    }

    if (payload.assigned_to && !this.repository.findUserById(payload.assigned_to)) {
      throw new AppError('Assigned mechanic was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    if (payload.technician_id && !this.repository.findTechnicianById(payload.technician_id)) {
      throw new AppError('Assigned technician was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    const odo = toNumber(payload.odometer_reading);
    if (odo < 0) {
      throw new AppError('Odometer reading cannot be negative.', 400, 'VALIDATION_ERROR');
    }

    if (odo < vehicle.odometer_reading) {
      throw new AppError(
        `Odometer reading cannot be less than the vehicle's last recorded reading (${vehicle.odometer_reading}).`,
        400,
        'VALIDATION_ERROR',
      );
    }

    return this.repository.transaction(() => {
      const jobCardId = this.repository.createJobCard({
        job_card_number:
          payload.job_card_number ||
          nextDocumentNumber(this.db, DocumentSeries.JOB_CARD, localDate()),
        customer_id: customerId,
        vehicle_id: vehicleId,
        status: 'DRAFT',
        complaint: payload.complaint || null,
        odometer_reading: odo,
        assigned_to: payload.assigned_to || null,
        technician_id: payload.technician_id || null,
        created_by: userId,
        fuel_level: payload.fuel_level || null,
        promised_delivery_at: payload.promised_delivery_at || null,
        toolkit_present: payload.toolkit_present ? 1 : 0,
        spare_wheel_present: payload.spare_wheel_present ? 1 : 0,
        jack_present: payload.jack_present ? 1 : 0,
        stereo_present: payload.stereo_present ? 1 : 0,
        battery_brand: payload.battery_brand || null,
      });

      const jobCard = this.get(jobCardId);
      this.auditRepository.create({
        userId,
        action: 'CREATE',
        entityType: 'job_cards',
        entityId: jobCardId,
        newValue: jobCard,
      });

      return jobCard;
    });
  }

  /**
   * Saves the fields the job card form filled in differently (customer_name
   * maps to name); blank fields never wipe what is stored.
   */
  updateChanged(table, row, payload, columns) {
    const changes = columns
      .map((column) => [column, payload[column === 'name' ? 'customer_name' : column]])
      .filter(([column, value]) => value && value !== row[column]);
    if (!changes.length) return;
    this.db
      .prepare(
        `UPDATE ${table} SET ${changes.map(([column]) => `${column} = ?`).join(', ')},
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(...changes.map(([, value]) => value), row.id);
  }

  addPart(jobCardId, payload, userId) {
    const jobCard = this.getMutableJobCard(jobCardId);
    required(payload.inventory_item_id, 'Inventory item');
    required(payload.batch_id, 'Batch');
    required(payload.quantity, 'Quantity');

    const item = this.repository.findInventoryItemById(payload.inventory_item_id);
    const batch = this.repository.findBatchById(payload.batch_id);
    if (!item || !batch || Number(batch.item_id) !== Number(item.id)) {
      throw new AppError('Inventory item or batch was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
    }

    const quantity = toNumber(payload.quantity);
    if (quantity <= 0) {
      throw new AppError('Quantity must be greater than zero.', 400, 'VALIDATION_ERROR');
    }

    if (toNumber(batch.quantity) < quantity) {
      throw new AppError('Insufficient stock for selected batch.', 400, 'INSUFFICIENT_STOCK');
    }

    const sellingPrice = roundMoney(payload.selling_price ?? item.selling_price);
    if (sellingPrice < 0) {
      throw new AppError('Selling price cannot be negative.', 400, 'VALIDATION_ERROR');
    }

    const gstRate = toNumber(payload.gst_rate ?? item.gst_rate);
    if (gstRate < 0 || gstRate > 100) {
      throw new AppError('GST rate must be between 0 and 100.', 400, 'VALIDATION_ERROR');
    }
    const revenue = roundMoney(sellingPrice * quantity);
    const gst = gstAmounts(revenue, gstRate);
    const categoryName = item.category_name || item.category || '';
    const itemType = /lubricant|lube|oil|fluid/i.test(categoryName) ? 'LUBRICANT' : 'PART';

    return this.repository.transaction(() => {
      const partId = this.repository.createPart({
        job_card_id: jobCard.id,
        item_type: itemType,
        inventory_item_id: item.id,
        batch_id: batch.id,
        description: payload.description || item.item_name,
        quantity,
        selling_price: sellingPrice,
        purchase_cost_snapshot: roundMoney(item.average_cost || item.purchase_cost),
        gst_rate: gstRate,
        gst_amount: gst.gstTotal,
        line_total: roundMoney(revenue + gst.gstTotal),
      });

      const part = this.repository.listParts(jobCard.id).find((row) => row.id === partId);
      this.auditRepository.create({
        userId,
        action: 'ADD_PART',
        entityType: 'job_cards',
        entityId: jobCard.id,
        newValue: part,
      });

      return part;
    });
  }

  addLabour(jobCardId, payload, userId) {
    const jobCard = this.getMutableJobCard(jobCardId);
    required(payload.description, 'Labour description');

    const labourCharge = roundMoney(payload.labour_charge ?? payload.charge);
    if (labourCharge < 0) {
      throw new AppError('Labour charge cannot be negative.', 400, 'VALIDATION_ERROR');
    }

    return this.repository.transaction(() => {
      const gstRate = toNumber(payload.gst_rate);
      if (gstRate < 0 || gstRate > 100) {
        throw new AppError('GST rate must be between 0 and 100.', 400, 'VALIDATION_ERROR');
      }

      const labourId = this.repository.createLabour({
        job_card_id: jobCard.id,
        description: String(payload.description).trim(),
        labour_charge: labourCharge,
        gst_rate: gstRate,
      });

      const labour = this.repository.listLabour(jobCard.id).find((row) => row.id === labourId);
      this.auditRepository.create({
        userId,
        action: 'ADD_LABOUR',
        entityType: 'job_cards',
        entityId: jobCard.id,
        newValue: labour,
      });

      return labour;
    });
  }

  /**
   * Removes a part or labour line from an unbilled job card. Parts are only
   * taken out of stock when the job is billed, so no stock reversal is needed.
   */
  removeLine(jobCardId, kind, lineId, userId) {
    const jobCard = this.getMutableJobCard(jobCardId);
    const table = { parts: 'job_card_items', labour: 'job_card_labour' }[kind];
    if (!table) throw new AppError('Unknown line type.', 400, 'VALIDATION_ERROR');
    return this.repository.transaction(() => {
      const line = this.db
        .prepare(`SELECT * FROM ${table} WHERE id = ? AND job_card_id = ?`)
        .get(lineId, jobCard.id);
      if (!line) throw new AppError('Line not found on this job card.', 404, 'LINE_NOT_FOUND');
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(line.id);
      this.auditRepository.create({
        userId,
        action: kind === 'parts' ? 'REMOVE_PART' : 'REMOVE_LABOUR',
        entityType: 'job_cards',
        entityId: jobCard.id,
        oldValue: line,
      });
      return { removed: true };
    });
  }

  /**
   * Cancels a job card that was never billed (for example the customer left).
   * No invoice number is used, and parts were never taken out of stock.
   */
  cancelJobCard(jobCardId, reason, userId) {
    const jobCard = this.getMutableJobCard(jobCardId);
    const cleanReason = String(reason || '').trim();
    if (!cleanReason) {
      throw new AppError('Give a short reason for cancelling.', 400, 'VALIDATION_ERROR');
    }
    return this.repository.transaction(() => {
      this.assertNoRunningTimer(
        jobCard.id,
        'Stop the mechanic timer on this job before cancelling it.',
        'MECHANIC_TIMER_RUNNING',
      );
      this.db
        .prepare(
          "UPDATE job_cards SET status = 'CANCELLED', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(jobCard.id);
      this.auditRepository.create({
        userId,
        action: 'CANCEL',
        entityType: 'job_cards',
        entityId: jobCard.id,
        oldValue: { status: jobCard.status },
        newValue: { status: 'CANCELLED', reason: cleanReason },
      });
      return this.get(jobCard.id);
    });
  }

  finalize(jobCardId, userId) {
    return this.repository.transaction(() => {
      const jobCard = this.getMutableJobCard(jobCardId);
      const parts = this.repository.listParts(jobCard.id);
      const labourRows = this.repository.listLabour(jobCard.id);
      this.assertNoRunningTimer(
        jobCard.id,
        'Stop all mechanic timers before billing this job.',
        'JOB_TIMER_RUNNING',
      );
      const approval = this.db
        .prepare('SELECT * FROM estimate_approvals WHERE job_card_id = ? ORDER BY id DESC LIMIT 1')
        .get(jobCard.id);
      if (approval && approval.status !== 'APPROVED') {
        throw new AppError(
          'Customer estimate approval is required before billing.',
          409,
          'ESTIMATE_APPROVAL_REQUIRED',
        );
      }

      if (parts.length === 0 && labourRows.length === 0) {
        throw new AppError(
          'At least one part or labour line is required before completion.',
          400,
          'VALIDATION_ERROR',
        );
      }

      const existingInvoice = this.repository.findInvoiceByJobCardId(jobCard.id);
      if (existingInvoice && existingInvoice.status !== 'CANCELLED') {
        throw new AppError(
          'This job card already has an active invoice.',
          400,
          'INVOICE_ALREADY_EXISTS',
        );
      }

      const interstate = isInterstate(
        this.db,
        this.repository.findCustomerById(jobCard.customer_id)?.state,
      );

      const partLines = parts.map((part) => {
        const stockOut = this.inventoryService.stockOut({
          itemId: part.inventory_item_id,
          warehouseId: part.warehouse_id,
          batchId: part.batch_id,
          quantity: part.quantity,
          transactionType: 'Consumption',
          referenceType: 'job_cards',
          referenceId: jobCard.id,
          notes: `Job card ${jobCard.job_card_number}`,
          userId,
        });

        const revenue = roundMoney(toNumber(part.selling_price) * toNumber(part.quantity));
        const cost = roundMoney(stockOut.unitCost * toNumber(part.quantity));
        const profit = roundMoney(revenue - cost);
        const gst = gstAmounts(revenue, part.gst_rate, interstate);

        return {
          item_type: part.item_type || 'PART',
          inventory_item_id: part.inventory_item_id,
          batch_id: part.batch_id,
          description: part.description,
          quantity: toNumber(part.quantity),
          unit_price: roundMoney(part.selling_price),
          purchase_cost_snapshot: stockOut.unitCost,
          gst_rate: toNumber(part.gst_rate),
          cgst_amount: gst.cgst,
          sgst_amount: gst.sgst,
          igst_amount: gst.igst,
          line_revenue: revenue,
          line_cost: cost,
          line_profit: profit,
          line_total: roundMoney(revenue + gst.gstTotal),
        };
      });

      const labourLines = labourRows.map((labour) => {
        const revenue = roundMoney(labour.labour_charge);
        const gst = gstAmounts(revenue, labour.gst_rate, interstate);
        const isOutside = String(labour.description).startsWith('[Outside Job]');

        return {
          item_type: isOutside ? 'OUTSIDE_JOB' : 'LABOR',
          inventory_item_id: null,
          batch_id: null,
          description: labour.description,
          quantity: 1,
          unit_price: revenue,
          purchase_cost_snapshot: 0,
          gst_rate: toNumber(labour.gst_rate),
          cgst_amount: gst.cgst,
          sgst_amount: gst.sgst,
          igst_amount: gst.igst,
          line_revenue: revenue,
          line_cost: 0,
          line_profit: revenue,
          line_total: roundMoney(revenue + gst.gstTotal),
        };
      });

      const invoiceLines = [...partLines, ...labourLines];
      const totals = this.calculateInvoiceTotals(invoiceLines);
      if (approval && totals.grandTotal > approval.amount + 0.005) {
        throw new AppError(
          'Invoice exceeds the approved estimate. Request approval for the revised amount.',
          409,
          'ESTIMATE_AMOUNT_EXCEEDED',
        );
      }

      // Refuse a bill that takes the customer over their credit limit.
      assertCustomerCreditLimit(this.db, 1, jobCard.customer_id, totals.grandTotal);

      const invoiceDate = localDate();
      const invoiceId = this.repository.createInvoice({
        invoice_number: nextDocumentNumber(this.db, DocumentSeries.WORKSHOP_INVOICE, invoiceDate),
        job_card_id: jobCard.id,
        customer_id: jobCard.customer_id,
        vehicle_id: jobCard.vehicle_id,
        invoice_date: invoiceDate,
        subtotal: totals.revenue,
        taxable_amount: totals.revenue,
        cgst_total: totals.cgst,
        sgst_total: totals.sgst,
        igst_total: totals.igst,
        gst_total: totals.gst,
        grand_total: totals.grandTotal,
        status: 'FINALIZED',
        revenue: totals.revenue,
        cost_total: totals.cost,
        gross_profit: totals.grossProfit,
        net_profit: totals.grossProfit,
        created_by: userId,
      });

      const warrantyMonths = this.db.prepare(
        'SELECT warranty_period_months FROM inventory_items WHERE id = ?',
      );
      const addWarranty = this.db.prepare(
        `INSERT INTO warranty_registrations (company_id, customer_id, vehicle_id, invoice_id,
           invoice_item_id, item_id, batch_number, start_date, end_date, status)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      );
      for (const line of invoiceLines) {
        const invoiceItemId = this.repository.createInvoiceItem({
          ...line,
          invoice_id: invoiceId,
        });

        // Parts with a warranty period get a warranty from the bill date.
        const months =
          line.item_type === 'PART' && line.inventory_item_id
            ? warrantyMonths.get(line.inventory_item_id)?.warranty_period_months
            : 0;
        if (months > 0)
          addWarranty.run(
            jobCard.customer_id,
            jobCard.vehicle_id,
            invoiceId,
            invoiceItemId,
            line.inventory_item_id,
            line.batch_id
              ? (this.repository.findBatchById(line.batch_id)?.batch_number ?? null)
              : null,
            invoiceDate,
            addMonths(invoiceDate, months),
          );
      }

      this.repository.createProfitRecord({
        invoice_id: invoiceId,
        revenue: totals.revenue,
        cost_total: totals.cost,
        gross_profit: totals.grossProfit,
        net_profit: totals.grossProfit,
      });

      // Sales voucher: the customer owes the bill; parts sales, labour sales and
      // output GST go up. A second voucher moves the parts' cost into COGS.
      const ledger = (key) => this.postingEngine.ledgerResolver.getLedgerId(1, key);
      const partsSubtotal = sum(partLines, (line) => line.line_revenue);
      const labourSubtotal = sum(labourLines, (line) => line.line_revenue);
      const salesEntries = [
        {
          ledgerId: this.postingEngine.getOrCreateCustomerLedger(1, jobCard.customer_id),
          type: 'DEBIT',
          amount: totals.grandTotal,
        },
      ];
      if (partsSubtotal > 0)
        salesEntries.push({
          ledgerId: ledger('parts_sales'),
          type: 'CREDIT',
          amount: partsSubtotal,
        });
      if (labourSubtotal > 0)
        salesEntries.push({
          ledgerId: ledger('labour_sales'),
          type: 'CREDIT',
          amount: labourSubtotal,
        });
      salesEntries.push(...taxLines(ledger, totals, 'CREDIT', 'output'));

      this.postingEngine.post({
        companyId: 1,
        voucherType: 'Sales',
        voucherDate: invoiceDate,
        referenceTable: 'invoices',
        referenceId: invoiceId,
        narration: `Sales invoice for Job Card ${jobCard.job_card_number}`,
        created_by: userId,
        entries: withRoundOff(ledger, salesEntries),
      });

      if (totals.cost > 0) {
        this.postingEngine.post({
          companyId: 1,
          voucherType: 'Journal',
          voucherDate: invoiceDate,
          referenceTable: 'invoices',
          referenceId: invoiceId,
          narration: `Cost of goods sold for Job Card ${jobCard.job_card_number}`,
          created_by: userId,
          entries: [
            { ledgerId: ledger('cogs'), type: 'DEBIT', amount: totals.cost },
            { ledgerId: ledger('inventory_stock'), type: 'CREDIT', amount: totals.cost },
          ],
        });
      }

      this.repository.updateJobCardStatus(jobCard.id, 'COMPLETED');
      this.repository.updateVehicleOdometer(jobCard.vehicle_id, jobCard.odometer_reading);

      const invoice = this.getInvoice(invoiceId);
      this.auditRepository.create({
        userId,
        action: 'FINALIZE',
        entityType: 'job_cards',
        entityId: jobCard.id,
        newValue: invoice,
      });

      return {
        jobCard: this.get(jobCard.id),
        invoice,
      };
    });
  }

  getInvoice(id) {
    const invoice = this.repository.findInvoiceById(id);
    if (!invoice) {
      throw new AppError('Invoice not found.', 404, 'INVOICE_NOT_FOUND');
    }

    // Invoices do not store the odometer; the printed bill shows the job card's reading.
    const jobCard = invoice.job_card_id
      ? this.db
          .prepare('SELECT odometer_reading FROM job_cards WHERE id = ?')
          .get(invoice.job_card_id)
      : null;

    return {
      ...invoice,
      odometer_reading: jobCard?.odometer_reading ?? null,
      items: this.repository.listInvoiceItems(id),
    };
  }

  cancelInvoice(id, userId) {
    return this.repository.transaction(() => {
      const invoice = this.getInvoice(id);
      if (invoice.status === 'CANCELLED') {
        throw new AppError('Invoice is already cancelled.', 400, 'INVOICE_ALREADY_CANCELLED');
      }

      if (invoice.status !== 'FINALIZED') {
        throw new AppError(
          'Only finalized invoices can be cancelled.',
          400,
          'INVALID_INVOICE_STATUS',
        );
      }

      // Money already paid on this bill stays with the customer as an advance.
      const advanceKept = releaseDocumentAllocations(this.db, 'job_card_invoice', invoice.id);
      if (roundMoney(toNumber(invoice.amount_paid) - advanceKept) > 0) {
        throw new AppError(
          'Some payment on this bill could not be matched. Ask for help before cancelling it.',
          400,
          'ACTIVE_ALLOCATIONS_EXIST',
        );
      }
      if (advanceKept > 0) {
        this.db
          .prepare(
            "UPDATE invoices SET amount_paid = 0, payment_status = 'UNPAID', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
          .run(invoice.id);
      }
      const returns = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM customer_returns WHERE invoice_id = ? AND status <> 'CANCELLED'",
        )
        .get(invoice.id).n;
      if (returns) {
        throw new AppError(
          'Invoice has active returns and cannot be cancelled.',
          400,
          'ACTIVE_RETURNS_EXIST',
        );
      }

      for (const item of invoice.items.filter(
        (line) => line.item_type === 'PART' || line.item_type === 'LUBRICANT',
      )) {
        const batch = this.repository.findBatchById(item.batch_id);
        if (!batch) {
          throw new AppError('Invoice batch was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
        }

        this.inventoryService.stockIn({
          itemId: item.inventory_item_id,
          warehouseId: batch.warehouse_id,
          supplierId: batch.supplier_id,
          batchNumber: batch.batch_number,
          manufactureDate: batch.manufacture_date,
          expiryDate: batch.expiry_date,
          quantity: item.quantity,
          unitCost: item.purchase_cost_snapshot,
          transactionType: 'Return',
          referenceType: 'invoices',
          referenceId: invoice.id,
          notes: `Invoice cancellation ${invoice.invoice_number}`,
          userId,
        });
      }
      // Delete/Reverse linked Vouchers from accounting engine
      const linkedVouchers = this.db
        .prepare("SELECT id FROM vouchers WHERE reference_table = 'invoices' AND reference_id = ?")
        .all(invoice.id);
      for (const v of linkedVouchers) {
        this.postingEngine.deleteVoucher(1, v.id);
      }

      this.db
        .prepare("UPDATE warranty_registrations SET status = 'EXPIRED' WHERE invoice_id = ?")
        .run(invoice.id);
      this.repository.cancelInvoice(invoice.id);
      this.repository.reverseProfitRecord(invoice.id);

      if (invoice.job_card_id) {
        this.repository.updateJobCardStatus(invoice.job_card_id, 'CANCELLED');
      }

      const cancelled = this.getInvoice(invoice.id);
      this.auditRepository.create({
        userId,
        action: 'CANCEL',
        entityType: 'invoices',
        entityId: invoice.id,
        oldValue: invoice,
        newValue: { ...cancelled, advance_kept: advanceKept },
      });

      return { ...cancelled, advance_kept: advanceKept };
    });
  }

  getMutableJobCard(jobCardId) {
    const jobCard = this.get(jobCardId);
    if (['COMPLETED', 'CANCELLED'].includes(jobCard.status)) {
      throw new AppError(
        'Completed or cancelled job cards cannot be changed.',
        400,
        'JOB_CARD_LOCKED',
      );
    }
    return jobCard;
  }

  /** A mechanic timer still running on the job blocks billing and cancelling. */
  assertNoRunningTimer(jobCardId, message, code) {
    const running = this.db
      .prepare('SELECT 1 FROM mechanic_time_entries WHERE job_card_id = ? AND stopped_at IS NULL')
      .get(jobCardId);
    if (running) throw new AppError(message, 409, code);
  }

  calculateInvoiceTotals(lines) {
    const total = (key) => roundMoney(sum(lines, (line) => toNumber(line[key])));
    const [revenue, cost, cgst, sgst, igst] = [
      'line_revenue',
      'line_cost',
      'cgst_amount',
      'sgst_amount',
      'igst_amount',
    ].map(total);
    const gst = roundMoney(cgst + sgst + igst);

    return {
      revenue,
      cost,
      cgst,
      sgst,
      igst,
      gst,
      grandTotal: roundMoney(revenue + gst),
      grossProfit: roundMoney(revenue - cost),
    };
  }
}

export function createJobCardService(db) {
  return new JobCardService(db);
}
