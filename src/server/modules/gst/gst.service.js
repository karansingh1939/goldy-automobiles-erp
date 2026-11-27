import { GstRepository } from './gst.repository.js';
import { roundMoney } from '../../shared/utils/numbers.js';
import { parseReportPeriod } from '../../shared/utils/report-period.js';

function mapSummaryRow(row) {
  return {
    invoiceCount: row.invoice_count,
    creditNoteCount: row.credit_note_count || 0,
    lineCount: row.line_count,
    taxableValue: roundMoney(row.taxable_value),
    cgstAmount: roundMoney(row.cgst_amount),
    sgstAmount: roundMoney(row.sgst_amount),
    igstAmount: roundMoney(row.igst_amount),
    totalTax: roundMoney(row.total_tax),
    grossValue: roundMoney(row.gross_value),
  };
}

function mapGstr1Row(row) {
  return {
    documentType: row.document_type || 'INVOICE',
    originalInvoiceNumber: row.original_invoice_number || null,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    status: row.status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerGstin: row.customer_gstin,
    placeOfSupply: row.place_of_supply,
    lineId: row.line_id,
    itemType: row.item_type,
    hsnSac: row.hsn_sac,
    description: row.description,
    quantity: roundMoney(row.quantity),
    unitPrice: roundMoney(row.unit_price),
    taxableValue: roundMoney(row.taxable_value),
    gstRate: roundMoney(row.gst_rate),
    cgstAmount: roundMoney(row.cgst_amount),
    sgstAmount: roundMoney(row.sgst_amount),
    igstAmount: roundMoney(row.igst_amount),
    totalTax: roundMoney(row.total_tax),
    lineTotal: roundMoney(row.line_total),
  };
}

function mapGstr3bDataset(dataset) {
  const outward = dataset.outward_supplies;
  const itc = dataset.eligible_itc;

  return {
    outwardSupplies: {
      invoiceCount: outward.invoice_count,
      taxableValue: roundMoney(outward.taxable_value),
      integratedTax: roundMoney(outward.integrated_tax),
      centralTax: roundMoney(outward.central_tax),
      stateUtTax: roundMoney(outward.state_ut_tax),
      cess: roundMoney(outward.cess),
      totalTax: roundMoney(outward.total_tax),
    },
    eligibleItc: {
      billCount: itc.bill_count,
      taxableValue: roundMoney(itc.taxable_value),
      integratedTax: roundMoney(itc.integrated_tax),
      centralTax: roundMoney(itc.central_tax),
      stateUtTax: roundMoney(itc.state_ut_tax),
      cess: roundMoney(itc.cess),
      totalTax: roundMoney(itc.total_tax),
    },
    rateBreakdown: dataset.rate_breakdown.map((row) => ({
      gstRate: roundMoney(row.gst_rate),
      taxableValue: roundMoney(row.taxable_value),
      cgstAmount: roundMoney(row.cgst_amount),
      sgstAmount: roundMoney(row.sgst_amount),
      igstAmount: roundMoney(row.igst_amount),
      totalTax: roundMoney(row.total_tax),
    })),
  };
}

function mapHsnRow(row) {
  return {
    hsnSac: row.hsn_sac,
    quantity: roundMoney(row.quantity),
    taxableValue: roundMoney(row.taxable_value),
    cgstAmount: roundMoney(row.cgst_amount),
    sgstAmount: roundMoney(row.sgst_amount),
    igstAmount: roundMoney(row.igst_amount),
    totalTax: roundMoney(row.total_tax),
  };
}

export class GstService {
  constructor(db) {
    this.db = db;
    this.repository = new GstRepository(db);
  }

  summary(query = {}) {
    const filters = parseReportPeriod(query, 'GST report');

    return {
      filters,
      data: mapSummaryRow(this.repository.summary(filters)),
    };
  }

  gstr1(query = {}) {
    const filters = parseReportPeriod(query, 'GST report');

    return {
      filters,
      data: this.repository.gstr1Dataset(filters).map(mapGstr1Row),
    };
  }

  gstr3b(query = {}) {
    const filters = parseReportPeriod(query, 'GST report');

    return {
      filters,
      data: mapGstr3bDataset(this.repository.gstr3bDataset(filters)),
    };
  }

  hsnSummary(query = {}) {
    const filters = parseReportPeriod(query, 'GST report');

    return {
      filters,
      data: this.repository.hsnSummary(filters).map(mapHsnRow),
    };
  }
}

export function createGstService(db) {
  return new GstService(db);
}
