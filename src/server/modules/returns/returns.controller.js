import { ReturnsService } from './returns.service.js';

export class ReturnsController {
  constructor(db) {
    this.service = new ReturnsService(db);
  }

  createCustomerReturn = async (req, res, next) => {
    try {
      const data = this.service.createCustomerReturn(req.body, req.user?.id || 1);
      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  };

  completeCustomerReturn = async (req, res, next) => {
    try {
      const data = this.service.completeCustomerReturn(Number(req.params.id), req.user?.id || 1);
      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  };

  cancelCustomerReturn = async (req, res, next) => {
    try {
      const data = this.service.cancelCustomerReturn(Number(req.params.id), req.user?.id || 1);
      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  };

  listCustomerReturns = async (req, res, next) => {
    try {
      const query = {
        companyId: req.query.companyId ? Number(req.query.companyId) : 1,
        customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
        invoiceId: req.query.invoiceId ? Number(req.query.invoiceId) : undefined,
        status: req.query.status,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
      };
      const data = this.service.repository.listCustomerReturns(query);
      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  };

  // SUPPLIER RETURNS
  createSupplierReturn = async (req, res, next) => {
    try {
      const data = this.service.createSupplierReturn(req.body, req.user?.id || 1);
      res.status(201).json({ data });
    } catch (error) {
      next(error);
    }
  };

  completeSupplierReturn = async (req, res, next) => {
    try {
      const data = this.service.completeSupplierReturn(Number(req.params.id), req.user?.id || 1);
      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  };

  cancelSupplierReturn = async (req, res, next) => {
    try {
      const data = this.service.cancelSupplierReturn(Number(req.params.id), req.user?.id || 1);
      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  };

  listSupplierReturns = async (req, res, next) => {
    try {
      const query = {
        companyId: req.query.companyId ? Number(req.query.companyId) : 1,
        supplierId: req.query.supplierId ? Number(req.query.supplierId) : undefined,
        purchaseId: req.query.purchaseId ? Number(req.query.purchaseId) : undefined,
        status: req.query.status,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
      };
      const data = this.service.repository.listSupplierReturns(query);
      res.status(200).json({ data });
    } catch (error) {
      next(error);
    }
  };
}
