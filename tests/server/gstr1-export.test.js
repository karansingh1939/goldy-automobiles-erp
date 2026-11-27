import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestContext } from './helpers.js';
import { localDate } from '../../src/server/shared/utils/local-date.js';

test('GSTR-1 export splits B2B and B2C, counts cancelled bills and downloads CSV', async () => {
  const context = await createTestContext();
  try {
    const login = await context.request('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'Admin@12345' }),
    });
    const headers = { Authorization: `Bearer ${login.body.token}` };
    const call = (path, body) =>
      context.request(path, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    const bill = async (suffix, labour) => {
      const job = await call('/api/v1/job-cards', {
        customer_name: `GST Test ${suffix}`,
        phone: `900006000${suffix}`,
        registration_number: `HR05GS000${suffix}`,
        make: 'Maruti',
        model: 'Alto',
        fuel_type: 'Petrol',
        odometer_reading: 1000,
        complaint: 'Service',
        fuel_level: '1/2',
      });
      await call(`/api/v1/job-cards/${job.body.data.id}/labour`, {
        description: 'Service labour',
        labour_charge: labour,
        gst_rate: 18,
      });
      return job.body.data;
    };

    const b2bJob = await bill(1, 1000);
    context.db
      .prepare("UPDATE customers SET gstin = '06ABCDE1234F1Z5', state = 'Haryana' WHERE id = ?")
      .run(b2bJob.customer_id);
    const b2b = await call(`/api/v1/job-cards/${b2bJob.id}/finalize`, {});
    assert.equal(b2b.response.status, 201, JSON.stringify(b2b.body));
    const b2cJob = await bill(2, 500);
    await call(`/api/v1/job-cards/${b2cJob.id}/finalize`, {});
    const cancelledJob = await bill(3, 200);
    const cancelled = await call(`/api/v1/job-cards/${cancelledJob.id}/finalize`, {});
    await call(`/api/v1/invoices/${cancelled.body.data.invoice.id}/cancel`, {});

    const today = localDate();
    const exported = await call(`/api/v1/gst/gstr1-export?dateFrom=${today}&dateTo=${today}`);
    assert.equal(exported.response.status, 200, JSON.stringify(exported.body));
    const { b2b: b2bRows, b2cs, b2cl, cdnur, hsn_b2b, hsn_b2c, docs } = exported.body.data;

    assert.equal(b2bRows.length, 1);
    assert.equal(b2bRows[0]['GSTIN/UIN of Recipient'], '06ABCDE1234F1Z5');
    assert.equal(b2bRows[0]['Taxable Value'], 1000);
    assert.equal(b2bRows[0]['Invoice Value'], 1180);
    assert.equal(b2bRows[0]['Place Of Supply'], '06-Haryana');
    assert.equal(b2bRows[0]['Invoice Type'], 'Regular B2B');

    assert.equal(b2cs.length, 1);
    assert.equal(b2cs[0].Type, 'OE');
    assert.equal(b2cs[0]['Taxable Value'], 500);
    assert.equal(b2cs[0]['Central Tax'], 45);
    assert.deepEqual([b2cl.length, cdnur.length], [0, 0]);

    assert.deepEqual(
      hsn_b2b.map((row) => [row.HSN, row['Taxable Value'], row.UQC, row['Total Quantity']]),
      [['9987', 1000, 'NA', 0]],
    );
    assert.deepEqual(
      hsn_b2c.map((row) => [row.HSN, row['Taxable Value']]),
      [['9987', 500]],
    );
    assert.equal(docs.length, 1);
    assert.equal(docs[0]['Total Number'], 3);
    assert.equal(docs[0].Cancelled, 1);
    assert.equal(docs[0]['Net Issued'], 2);

    const csv = await context.request(
      `/api/v1/gst/gstr1-export/b2b.csv?dateFrom=${today}&dateTo=${today}`,
      { headers },
    );
    assert.equal(csv.response.status, 200);
    assert.match(csv.response.headers.get('content-type'), /text\/csv/);
    assert.match(
      csv.body,
      /GSTIN\/UIN of Recipient,Receiver Name,Invoice Number,Invoice date,Invoice Value,Place Of Supply,Reverse Charge,Applicable % of Tax Rate,Invoice Type,E-Commerce GSTIN,Rate,Taxable Value,Cess Amount\r\n/,
    );
    assert.match(csv.body, /06ABCDE1234F1Z5/);

    const noPeriod = await call('/api/v1/gst/gstr1-export');
    assert.equal(noPeriod.response.status, 400);
  } finally {
    await context.close();
  }
});

test('GSTR-1 puts big other-state B2C bills in B2CL and nets small credit notes into B2CS', async () => {
  const context = await createTestContext();
  try {
    const { Gstr1ExportService } =
      await import('../../src/server/modules/gst/gstr1-export.service.js');
    const service = new Gstr1ExportService(context.db);
    const line = (overrides) => ({
      documentType: 'INVOICE',
      customerGstin: '',
      customerName: 'Walk-in',
      invoiceDate: '2026-11-10',
      placeOfSupply: 'Haryana',
      gstRate: 18,
      hsnSac: '9987',
      description: 'Labour',
      quantity: 1,
      igstAmount: 0,
      ...overrides,
    });
    const data = [
      // Local walk-in bill and a return on it.
      line({
        invoiceNumber: 'INV/26-27/0001',
        taxableValue: 1000,
        cgstAmount: 90,
        sgstAmount: 90,
        lineTotal: 1180,
      }),
      line({
        documentType: 'CREDIT_NOTE',
        invoiceNumber: 'CN/26-27/0001',
        originalInvoiceNumber: 'INV/26-27/0001',
        taxableValue: -200,
        cgstAmount: -18,
        sgstAmount: -18,
        lineTotal: -236,
      }),
      // Other-state walk-in bill over ₹1 lakh.
      line({
        invoiceNumber: 'INV/26-27/0002',
        placeOfSupply: 'Punjab',
        taxableValue: 100000,
        igstAmount: 18000,
        cgstAmount: 0,
        sgstAmount: 0,
        lineTotal: 118000,
      }),
    ];
    service.gst = {
      gstr1: () => ({ filters: { dateFrom: '2026-11-01', dateTo: '2026-11-30' }, data }),
    };
    const built = service.build({});
    assert.deepEqual(
      built.b2cs.map((row) => [row['Place Of Supply'], row['Taxable Value'], row['Central Tax']]),
      [['06-Haryana', 800, 72]],
    );
    assert.equal(built.b2cl.length, 1);
    assert.equal(built.b2cl[0]['Invoice Value'], 118000);
    assert.equal(built.b2cl[0]['Place Of Supply'], '03-Punjab');
    assert.equal(built.cdnur.length, 0);
    assert.equal(built.hsn_b2c[0]['Taxable Value'], 100800);
    assert.match(
      service.csv('b2cl', {}),
      /^\uFEFFInvoice Number,Invoice date,Invoice Value,Place Of Supply/,
    );
  } finally {
    await context.close();
  }
});
