const JOB_CARD_FROM = `FROM job_cards
  JOIN customers ON customers.id = job_cards.customer_id
  JOIN vehicles ON vehicles.id = job_cards.vehicle_id`;

// Fields a job card search can match exactly, in the order they are tried.
const SEARCH_FIELDS = {
  job_card_number: {
    label: 'Job Card Number',
    column: 'job_cards.job_card_number',
    exact: 'job_cards.job_card_number = ? COLLATE NOCASE',
  },
  registration_number: {
    label: 'Registration Number',
    column: 'vehicles.registration_number',
    exact: 'vehicles.registration_number = ? COLLATE NOCASE',
  },
  phone: { label: 'Phone Number', column: 'customers.phone', exact: 'customers.phone = ?' },
  name: {
    label: 'Customer Name',
    column: 'customers.name',
    exact: 'customers.name = ? COLLATE NOCASE',
  },
};
const PARTIAL_COLUMNS = [
  'job_cards.job_card_number',
  'customers.name',
  'customers.phone',
  'vehicles.registration_number',
  'vehicles.engine_number',
  'vehicles.chassis_number',
];

export class JobCardRepository {
  constructor(db) {
    this.db = db;
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  findCustomerById(id) {
    return this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  }

  findVehicleById(id) {
    return this.db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  }

  findUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  findInventoryItemById(id) {
    return this.db
      .prepare(
        `
      SELECT inventory_items.*, inventory_categories.name AS category_name
      FROM inventory_items
      LEFT JOIN inventory_categories ON inventory_categories.id = inventory_items.category_id
      WHERE inventory_items.id = ?
    `,
      )
      .get(id);
  }

  findBatchById(id) {
    return this.db.prepare('SELECT * FROM inventory_batches WHERE id = ?').get(id);
  }

  /**
   * Job cards for the list, newest first. A search first looks for an exact
   * job card number, car number, phone or customer name (the kind it looks
   * like first); with no exact match it searches parts of those fields.
   */
  listJobCards({ search, status, fromDate, toDate, exactMatchOnly, pageSize, offset }) {
    const conditions = [];
    const params = [];
    if (status) {
      conditions.push('job_cards.status = ?');
      params.push(status);
    }
    if (fromDate) {
      conditions.push("DATE(job_cards.opened_at, 'localtime') >= DATE(?)");
      params.push(fromDate);
    }
    if (toDate) {
      conditions.push("DATE(job_cards.opened_at, 'localtime') <= DATE(?)");
      params.push(toDate);
    }

    let matchType = '';
    let matchValue = '';
    let orderBy = 'job_cards.opened_at DESC, job_cards.id DESC';
    const orderParams = [];
    const query = search?.trim();
    if (query) {
      const looksLike = /^\d+$/.test(query)
        ? 'phone'
        : /^JC[-/]\d/i.test(query)
          ? 'job_card_number'
          : /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/i.test(query) ||
              (/^[A-Z0-9\s-]+$/i.test(query) && /[A-Z]/i.test(query) && /\d/.test(query))
            ? 'registration_number'
            : 'name';
      const order = [looksLike, ...Object.keys(SEARCH_FIELDS).filter((key) => key !== looksLike)];
      const exact = order.find(
        (key) =>
          this.db
            .prepare(`SELECT 1 ${JOB_CARD_FROM} WHERE ${SEARCH_FIELDS[key].exact} LIMIT 1`)
            .get(query) !== undefined,
      );
      if (exact) {
        matchType = SEARCH_FIELDS[exact].label;
        matchValue = query;
        conditions.push(SEARCH_FIELDS[exact].exact);
        params.push(query);
      } else if (exactMatchOnly) {
        return { data: [], total: 0, unfilteredTotal: this.countAll(), matchType, matchValue };
      } else {
        const like = `%${query}%`;
        conditions.push(
          `(${PARTIAL_COLUMNS.map((c) => `${c} LIKE ? COLLATE NOCASE`).join(' OR ')})`,
        );
        params.push(...PARTIAL_COLUMNS.map(() => like));
        // Rows matching the kind of value typed come first.
        orderBy = `CASE WHEN ${SEARCH_FIELDS[looksLike].column} LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END, ${orderBy}`;
        orderParams.push(like);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const data = this.db
      .prepare(
        `SELECT
           job_cards.*,
           customers.name AS customer_name,
           customers.phone AS customer_phone,
           vehicles.registration_number,
           vehicles.engine_number,
           vehicles.chassis_number,
           COALESCE(technicians.full_name, users.name) AS assigned_mechanic_name,
           (SELECT invoice_number FROM invoices
             WHERE invoices.job_card_id = job_cards.id ORDER BY invoices.id DESC LIMIT 1) AS invoice_number
         ${JOB_CARD_FROM}
         LEFT JOIN users ON users.id = job_cards.assigned_to
         LEFT JOIN technicians ON technicians.id = job_cards.technician_id
         ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, ...orderParams, pageSize, offset);
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count ${JOB_CARD_FROM} ${where}`)
      .get(...params).count;
    return { data, total, unfilteredTotal: this.countAll(), matchType, matchValue };
  }

  countAll() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM job_cards').get().count;
  }

  findJobCardById(id) {
    return this.db
      .prepare(
        `
      SELECT
        job_cards.*,
        customers.name AS customer_name,
        customers.phone AS customer_phone,
        vehicles.registration_number,
        vehicles.engine_number,
        vehicles.chassis_number,
        COALESCE(technicians.full_name, users.name) AS assigned_mechanic_name
      FROM job_cards
      JOIN customers ON customers.id = job_cards.customer_id
      JOIN vehicles ON vehicles.id = job_cards.vehicle_id
      LEFT JOIN users ON users.id = job_cards.assigned_to
      LEFT JOIN technicians ON technicians.id = job_cards.technician_id
      WHERE job_cards.id = ?
    `,
      )
      .get(id);
  }

  findTechnicianById(id) {
    return this.db.prepare('SELECT * FROM technicians WHERE id = ?').get(id);
  }

  createJobCard(data) {
    const result = this.db
      .prepare(
        `
      INSERT INTO job_cards (
        job_card_number,
        customer_id,
        vehicle_id,
        status,
        complaint,
        odometer_reading,
        assigned_to,
        technician_id,
        created_by,
        fuel_level,
        promised_delivery_at,
        toolkit_present,
        spare_wheel_present,
        jack_present,
        stereo_present,
        battery_brand
      )
      VALUES (
        @job_card_number,
        @customer_id,
        @vehicle_id,
        @status,
        @complaint,
        @odometer_reading,
        @assigned_to,
        @technician_id,
        @created_by,
        @fuel_level,
        @promised_delivery_at,
        @toolkit_present,
        @spare_wheel_present,
        @jack_present,
        @stereo_present,
        @battery_brand
      )
    `,
      )
      .run(data);

    return result.lastInsertRowid;
  }

  updateJobCardStatus(id, status) {
    this.db
      .prepare(
        `
      UPDATE job_cards
      SET status = ?,
          closed_at = CASE WHEN ? = 'COMPLETED' THEN CURRENT_TIMESTAMP ELSE closed_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      )
      .run(status, status, id);
  }

  updateVehicleOdometer(vehicleId, odometerReading) {
    this.db
      .prepare(
        `
      UPDATE vehicles
      SET odometer_reading = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      )
      .run(odometerReading, vehicleId);
  }

  createPart(data) {
    const result = this.db
      .prepare(
        `
      INSERT INTO job_card_items (
        job_card_id,
        item_type,
        inventory_item_id,
        batch_id,
        description,
        quantity,
        selling_price,
        purchase_cost_snapshot,
        gst_rate,
        gst_amount,
        line_total
      )
      VALUES (
        @job_card_id,
        @item_type,
        @inventory_item_id,
        @batch_id,
        @description,
        @quantity,
        @selling_price,
        @purchase_cost_snapshot,
        @gst_rate,
        @gst_amount,
        @line_total
      )
    `,
      )
      .run(data);

    return result.lastInsertRowid;
  }

  createLabour(data) {
    const result = this.db
      .prepare(
        `
      INSERT INTO job_card_labour (
        job_card_id,
        description,
        labour_charge,
        gst_rate
      )
      VALUES (
        @job_card_id,
        @description,
        @labour_charge,
        @gst_rate
      )
    `,
      )
      .run(data);

    return result.lastInsertRowid;
  }

  listParts(jobCardId) {
    return this.db
      .prepare(
        `
      SELECT
        job_card_items.*,
        inventory_items.sku,
        inventory_items.item_name,
        inventory_items.category,
        inventory_batches.warehouse_id
      FROM job_card_items
      JOIN inventory_items ON inventory_items.id = job_card_items.inventory_item_id
      JOIN inventory_batches ON inventory_batches.id = job_card_items.batch_id
      WHERE job_card_items.job_card_id = ?
        AND job_card_items.item_type IN ('PART', 'LUBRICANT')
      ORDER BY job_card_items.id
    `,
      )
      .all(jobCardId);
  }

  listLabour(jobCardId) {
    return this.db
      .prepare(
        `
      SELECT *
      FROM job_card_labour
      WHERE job_card_id = ?
      ORDER BY id
    `,
      )
      .all(jobCardId);
  }

  createInvoice(data) {
    const result = this.db
      .prepare(
        `
      INSERT INTO invoices (
        invoice_number,
        job_card_id,
        customer_id,
        vehicle_id,
        invoice_date,
        subtotal,
        taxable_amount,
        cgst_total,
        sgst_total,
        igst_total,
        gst_total,
        grand_total,
        status,
        revenue,
        cost_total,
        gross_profit,
        net_profit,
        created_by
      )
      VALUES (
        @invoice_number,
        @job_card_id,
        @customer_id,
        @vehicle_id,
        @invoice_date,
        @subtotal,
        @taxable_amount,
        @cgst_total,
        @sgst_total,
        @igst_total,
        @gst_total,
        @grand_total,
        @status,
        @revenue,
        @cost_total,
        @gross_profit,
        @net_profit,
        @created_by
      )
    `,
      )
      .run(data);

    return result.lastInsertRowid;
  }

  createInvoiceItem(data) {
    const result = this.db
      .prepare(
        `
      INSERT INTO invoice_items (
        invoice_id,
        item_type,
        inventory_item_id,
        batch_id,
        description,
        quantity,
        unit_price,
        purchase_cost_snapshot,
        gst_rate,
        cgst_amount,
        sgst_amount,
        igst_amount,
        line_revenue,
        line_cost,
        line_profit,
        line_total
      )
      VALUES (
        @invoice_id,
        @item_type,
        @inventory_item_id,
        @batch_id,
        @description,
        @quantity,
        @unit_price,
        @purchase_cost_snapshot,
        @gst_rate,
        @cgst_amount,
        @sgst_amount,
        @igst_amount,
        @line_revenue,
        @line_cost,
        @line_profit,
        @line_total
      )
    `,
      )
      .run(data);

    return result.lastInsertRowid;
  }

  createProfitRecord(data) {
    const result = this.db
      .prepare(
        `
      INSERT INTO profit_records (
        invoice_id,
        revenue,
        cost_total,
        gross_profit,
        expense_total,
        net_profit
      )
      VALUES (
        @invoice_id,
        @revenue,
        @cost_total,
        @gross_profit,
        0,
        @net_profit
      )
    `,
      )
      .run(data);

    return result.lastInsertRowid;
  }

  findInvoiceById(id) {
    return this.db
      .prepare(
        `
      SELECT *
      FROM invoices
      WHERE id = ?
    `,
      )
      .get(id);
  }

  findInvoiceByJobCardId(jobCardId) {
    return this.db
      .prepare(
        `
      SELECT *
      FROM invoices
      WHERE job_card_id = ?
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get(jobCardId);
  }

  listInvoiceItems(invoiceId) {
    return this.db
      .prepare(
        `
      SELECT
        invoice_items.*,
        inventory_items.category,
        CASE WHEN invoice_items.inventory_item_id IS NULL THEN '9987'
          ELSE inventory_items.hsn_code END AS hsn_code
      FROM invoice_items
      LEFT JOIN inventory_items ON inventory_items.id = invoice_items.inventory_item_id
      WHERE invoice_items.invoice_id = ?
      ORDER BY invoice_items.id
    `,
      )
      .all(invoiceId);
  }

  cancelInvoice(id) {
    this.db
      .prepare(
        `
      UPDATE invoices
      SET status = 'CANCELLED',
          payment_status = 'UNPAID',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      )
      .run(id);
  }

  reverseProfitRecord(invoiceId) {
    this.db
      .prepare(
        `
      UPDATE profit_records
      SET revenue = 0,
          cost_total = 0,
          gross_profit = 0,
          expense_total = 0,
          net_profit = 0
      WHERE invoice_id = ?
    `,
      )
      .run(invoiceId);
  }
}
