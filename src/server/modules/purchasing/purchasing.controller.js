import { respond, respondData } from '../../shared/http/respond.js';

export class PurchasingController {
  constructor(purchasingService) {
    this.purchasingService = purchasingService;
  }

  listOrders = respond((req) => this.purchasingService.listOrders(req.query));

  createOrder = respondData(
    (req) => this.purchasingService.createOrder(req.body || {}, req.user?.id),
    201,
  );

  listReceipts = respond((req) => this.purchasingService.listReceipts(req.query));

  getReceipt = respondData((req) => this.purchasingService.getReceipt(Number(req.params.id)));

  createReceipt = respondData(
    (req) => this.purchasingService.createReceipt(req.body || {}, req.user?.id),
    201,
  );

  getSupplierLedger = respond((req) =>
    this.purchasingService.getSupplierLedger(Number(req.params.supplierId), req.query),
  );
}
