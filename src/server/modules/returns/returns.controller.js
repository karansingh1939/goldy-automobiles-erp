import { ReturnsService } from './returns.service.js';
import { respond } from '../../shared/http/respond.js';

export class ReturnsController {
  constructor(db) {
    this.service = new ReturnsService(db);
  }

  createCustomerReturn = respond((req) => {
    const data = this.service.createCustomerReturn(req.body, req.user?.id || 1);
    return { data };
  }, 201);

  completeCustomerReturn = respond((req) => {
    const data = this.service.completeCustomerReturn(Number(req.params.id), req.user?.id || 1);
    return { data };
  });

  cancelCustomerReturn = respond((req) => {
    const data = this.service.cancelCustomerReturn(Number(req.params.id), req.user?.id || 1);
    return { data };
  });

  listCustomerReturns = respond((req) => {
    const query = {
      companyId: req.query.companyId ? Number(req.query.companyId) : 1,
      customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
      invoiceId: req.query.invoiceId ? Number(req.query.invoiceId) : undefined,
      status: req.query.status,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };
    const data = this.service.repository.listCustomerReturns(query);
    return { data };
  });

  // SUPPLIER RETURNS
  createSupplierReturn = respond((req) => {
    const data = this.service.createSupplierReturn(req.body, req.user?.id || 1);
    return { data };
  }, 201);

  completeSupplierReturn = respond((req) => {
    const data = this.service.completeSupplierReturn(Number(req.params.id), req.user?.id || 1);
    return { data };
  });

  cancelSupplierReturn = respond((req) => {
    const data = this.service.cancelSupplierReturn(Number(req.params.id), req.user?.id || 1);
    return { data };
  });

  listSupplierReturns = respond((req) => {
    const query = {
      companyId: req.query.companyId ? Number(req.query.companyId) : 1,
      supplierId: req.query.supplierId ? Number(req.query.supplierId) : undefined,
      purchaseId: req.query.purchaseId ? Number(req.query.purchaseId) : undefined,
      status: req.query.status,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };
    const data = this.service.repository.listSupplierReturns(query);
    return { data };
  });
}
