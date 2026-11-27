import { AppError } from '../../shared/errors/app-error.js';
import { GstService } from './gst.service.js';
import { stateCodeFor } from '../settings/company-settings.js';

/**
 * GSTR-1 files for the CA. Each CSV follows the import template of the GST
 * Offline Tool sheet of the same name (b2b, b2cl, b2cs, cdnr, cdnur, hsn,
 * docs), so it can be imported as it is. The JSON preview also carries the
 * tax amounts so the figures can be checked on screen first.
 */

// Byte-order mark so Excel opens the CSV as UTF-8 (₹ and Hindi names).
const BOM = String.fromCharCode(0xfeff);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Inter-state bills to unregistered buyers above this go invoice-wise in B2CL. */
export const B2CL_LIMIT = 100000;
/** The GST offline tool reads dates as dd-mmm-yyyy, e.g. 26-Nov-2026. */
const gstDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? `${match[3]}-${MONTHS[Number(match[2]) - 1]}-${match[1]}` : value;
};
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const pos = (state, fallback) => {
  const name = state || fallback || '';
  const code = stateCodeFor(name);
  return code ? `${code}-${name}` : name;
};

function groupBy(rows, keyFn, init, add) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, init(row));
    add(map.get(key), row);
  }
  return [...map.values()];
}

/** Adds a line's values (signed: credit notes subtract) to a grouped row. */
function addTax(acc, row, sign = 1) {
  acc['Taxable Value'] = round2(acc['Taxable Value'] + sign * Math.abs(row.taxableValue));
  acc['Integrated Tax'] = round2(acc['Integrated Tax'] + sign * Math.abs(row.igstAmount));
  acc['Central Tax'] = round2(acc['Central Tax'] + sign * Math.abs(row.cgstAmount));
  acc['State/UT Tax'] = round2(acc['State/UT Tax'] + sign * Math.abs(row.sgstAmount));
}
const zeroTax = () => ({
  'Taxable Value': 0,
  'Integrated Tax': 0,
  'Central Tax': 0,
  'State/UT Tax': 0,
  'Cess Amount': 0,
});

const HSN_COLUMNS = [
  'HSN',
  'Description',
  'UQC',
  'Total Quantity',
  'Total Value',
  'Rate',
  'Taxable Value',
  'Integrated Tax Amount',
  'Central Tax Amount',
  'State/UT Tax Amount',
  'Cess Amount',
];

export const SECTIONS = {
  b2b: {
    title: 'B2B bills (customers with GSTIN)',
    columns: [
      'GSTIN/UIN of Recipient',
      'Receiver Name',
      'Invoice Number',
      'Invoice date',
      'Invoice Value',
      'Place Of Supply',
      'Reverse Charge',
      'Applicable % of Tax Rate',
      'Invoice Type',
      'E-Commerce GSTIN',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  },
  b2cl: {
    title: 'B2C large (other-state customers without GSTIN, bill over ₹1 lakh)',
    columns: [
      'Invoice Number',
      'Invoice date',
      'Invoice Value',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ],
  },
  b2cs: {
    title: 'B2C small (customers without GSTIN), by state and rate',
    columns: [
      'Type',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ],
  },
  cdnr: {
    title: 'Credit notes to customers with GSTIN',
    columns: [
      'GSTIN/UIN of Recipient',
      'Receiver Name',
      'Note Number',
      'Note Date',
      'Note Type',
      'Place Of Supply',
      'Reverse Charge',
      'Note Supply Type',
      'Note Value',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  },
  cdnur: {
    title: 'Credit notes on B2C large bills',
    columns: [
      'UR Type',
      'Note Number',
      'Note Date',
      'Note Type',
      'Place Of Supply',
      'Note Value',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  },
  hsn_b2b: { title: 'HSN/SAC summary – B2B', columns: HSN_COLUMNS },
  hsn_b2c: { title: 'HSN/SAC summary – B2C', columns: HSN_COLUMNS },
  docs: {
    title: 'Documents issued',
    columns: ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
  },
};

export class Gstr1ExportService {
  constructor(db) {
    this.db = db;
    this.gst = new GstService(db);
  }

  build(query = {}) {
    const { filters, data } = this.gst.gstr1(query);
    if (!filters.dateFrom || !filters.dateTo)
      throw new AppError('Choose the return period (from and to dates).', 400, 'VALIDATION_ERROR');
    const companyState =
      this.db.prepare('SELECT state FROM companies WHERE id = 1').get()?.state || 'Haryana';
    const registered = (row) => Boolean(String(row.customerGstin || '').trim());
    const interState = (row) => Math.abs(Number(row.igstAmount || 0)) > 0;

    const invoices = data.filter((row) => row.documentType === 'INVOICE');
    const notes = data.filter((row) => row.documentType === 'CREDIT_NOTE');

    const documentValue = new Map();
    for (const row of data)
      documentValue.set(
        row.invoiceNumber,
        round2((documentValue.get(row.invoiceNumber) || 0) + Math.abs(row.lineTotal)),
      );
    const originalValue = (number) => {
      if (!number) return 0;
      if (documentValue.has(number)) return documentValue.get(number);
      const found = this.db
        .prepare(
          `SELECT grand_total FROM invoices WHERE invoice_number = ?
           UNION ALL SELECT grand_total FROM direct_invoices WHERE invoice_number = ?`,
        )
        .get(number, number);
      return Number(found?.grand_total || 0);
    };
    const isLarge = (row) =>
      !registered(row) && interState(row) && documentValue.get(row.invoiceNumber) > B2CL_LIMIT;
    const noteOnLarge = (row) =>
      !registered(row) && interState(row) && originalValue(row.originalInvoiceNumber) > B2CL_LIMIT;

    const b2b = groupBy(
      invoices.filter(registered),
      (row) => `${row.invoiceNumber}|${row.gstRate}`,
      (row) => ({
        'GSTIN/UIN of Recipient': row.customerGstin,
        'Receiver Name': row.customerName,
        'Invoice Number': row.invoiceNumber,
        'Invoice date': gstDate(row.invoiceDate),
        'Invoice Value': documentValue.get(row.invoiceNumber),
        'Place Of Supply': pos(row.placeOfSupply, companyState),
        'Reverse Charge': 'N',
        'Applicable % of Tax Rate': '',
        'Invoice Type': 'Regular B2B',
        'E-Commerce GSTIN': '',
        Rate: row.gstRate,
        ...zeroTax(),
      }),
      (acc, row) => addTax(acc, row),
    );

    const b2cl = groupBy(
      invoices.filter(isLarge),
      (row) => `${row.invoiceNumber}|${row.gstRate}`,
      (row) => ({
        'Invoice Number': row.invoiceNumber,
        'Invoice date': gstDate(row.invoiceDate),
        'Invoice Value': documentValue.get(row.invoiceNumber),
        'Place Of Supply': pos(row.placeOfSupply, companyState),
        'Applicable % of Tax Rate': '',
        Rate: row.gstRate,
        'E-Commerce GSTIN': '',
        ...zeroTax(),
      }),
      (acc, row) => addTax(acc, row),
    );

    // Small B2C bills, less the credit notes given on them, by state and rate.
    const b2csLines = [
      ...invoices.filter((row) => !registered(row) && !isLarge(row)),
      ...notes.filter((row) => !registered(row) && !noteOnLarge(row)),
    ];
    const b2cs = groupBy(
      b2csLines,
      (row) => `${row.placeOfSupply || companyState}|${row.gstRate}`,
      (row) => ({
        Type: 'OE',
        'Place Of Supply': pos(row.placeOfSupply, companyState),
        'Applicable % of Tax Rate': '',
        Rate: row.gstRate,
        'E-Commerce GSTIN': '',
        ...zeroTax(),
      }),
      (acc, row) => addTax(acc, row, row.documentType === 'CREDIT_NOTE' ? -1 : 1),
    );

    const noteRow = (row) => ({
      'Note Number': row.invoiceNumber,
      'Note Date': gstDate(row.invoiceDate),
      'Note Type': 'C',
      'Place Of Supply': pos(row.placeOfSupply, companyState),
      'Note Value': documentValue.get(row.invoiceNumber),
      'Applicable % of Tax Rate': '',
      Rate: row.gstRate,
      'Original Invoice Number': row.originalInvoiceNumber || '',
      ...zeroTax(),
    });
    const cdnr = groupBy(
      notes.filter(registered),
      (row) => `${row.invoiceNumber}|${row.gstRate}`,
      (row) => ({
        'GSTIN/UIN of Recipient': row.customerGstin,
        'Receiver Name': row.customerName,
        'Reverse Charge': 'N',
        'Note Supply Type': 'Regular B2B',
        ...noteRow(row),
      }),
      (acc, row) => addTax(acc, row),
    );
    const cdnur = groupBy(
      notes.filter(noteOnLarge),
      (row) => `${row.invoiceNumber}|${row.gstRate}`,
      (row) => ({ 'UR Type': 'B2CL', ...noteRow(row) }),
      (acc, row) => addTax(acc, row),
    );

    // Credit notes reduce the HSN totals of the side (B2B / B2C) they belong to.
    const hsnFor = (rows) =>
      groupBy(
        rows,
        (row) => `${row.hsnSac}|${row.gstRate}`,
        (row) => ({
          HSN: row.hsnSac,
          Description: row.hsnSac === '9987' ? 'Repair and maintenance services' : row.description,
          UQC: row.hsnSac === '9987' ? 'NA' : 'NOS-NUMBERS',
          'Total Quantity': 0,
          'Total Value': 0,
          Rate: row.gstRate,
          'Taxable Value': 0,
          'Integrated Tax Amount': 0,
          'Central Tax Amount': 0,
          'State/UT Tax Amount': 0,
          'Cess Amount': 0,
        }),
        (acc, row) => {
          const sign = row.documentType === 'CREDIT_NOTE' ? -1 : 1;
          const add = (key, value) => {
            acc[key] = round2(acc[key] + sign * Math.abs(Number(value || 0)));
          };
          // Services (SAC 9987) are reported without a quantity.
          if (row.hsnSac !== '9987') add('Total Quantity', row.quantity);
          add('Total Value', row.lineTotal);
          add('Taxable Value', row.taxableValue);
          add('Integrated Tax Amount', row.igstAmount);
          add('Central Tax Amount', row.cgstAmount);
          add('State/UT Tax Amount', row.sgstAmount);
        },
      );

    return {
      filters,
      b2b,
      b2cl,
      b2cs,
      cdnr,
      cdnur,
      hsn_b2b: hsnFor(data.filter(registered)),
      hsn_b2c: hsnFor(data.filter((row) => !registered(row))),
      docs: this.documentsIssued(filters),
    };
  }

  /** Table 13: invoice series issued in the period, including cancelled ones. */
  documentsIssued({ dateFrom, dateTo }) {
    const series = (
      table,
      nature,
      numberColumn = 'invoice_number',
      dateColumn = 'invoice_date',
      extraWhere = '',
    ) =>
      this.db
        .prepare(
          `SELECT ${numberColumn} AS invoice_number, status FROM ${table}
           WHERE ${dateColumn} BETWEEN ? AND ? AND ${numberColumn} LIKE '%/%/%' ${extraWhere} ORDER BY ${numberColumn}`,
        )
        .all(dateFrom, dateTo)
        .reduce((groups, row) => {
          const prefix = row.invoice_number.slice(0, row.invoice_number.lastIndexOf('/') + 1);
          (groups[prefix] ||= { nature, rows: [] }).rows.push(row);
          return groups;
        }, {});
    const groups = {
      ...series('invoices', 'Invoices for outward supply'),
      ...series('direct_invoices', 'Invoices for outward supply'),
      // Draft returns are not issued yet.
      ...series(
        'customer_returns',
        'Credit Note',
        'return_number',
        'return_date',
        "AND status <> 'DRAFT'",
      ),
    };
    return Object.entries(groups).map(([prefix, { nature, rows }]) => {
      const cancelled = rows.filter((row) => row.status === 'CANCELLED').length;
      return {
        'Nature of Document': nature,
        Series: prefix,
        'Sr. No. From': rows[0].invoice_number,
        'Sr. No. To': rows[rows.length - 1].invoice_number,
        'Total Number': rows.length,
        Cancelled: cancelled,
        'Net Issued': rows.length - cancelled,
      };
    });
  }

  csv(section, query) {
    const spec = SECTIONS[section];
    if (!spec) throw new AppError('Unknown GSTR-1 section.', 400, 'VALIDATION_ERROR');
    const rows = this.build(query)[section];
    const cell = (value) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const lines = [spec.columns.map(cell).join(',')];
    for (const row of rows) lines.push(spec.columns.map((column) => cell(row[column])).join(','));
    return `${BOM}${lines.join('\r\n')}\r\n`;
  }
}
