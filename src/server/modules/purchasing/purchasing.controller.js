export class PurchasingController {
  constructor(purchasingService) {
    this.purchasingService = purchasingService;
  }

  listOrders = (req, res, next) => {
    try {
      res.status(200).json(this.purchasingService.listOrders(req.query));
    } catch (error) {
      next(error);
    }
  };

  createOrder = (req, res, next) => {
    try {
      res
        .status(201)
        .json({ data: this.purchasingService.createOrder(req.body || {}, req.user?.id) });
    } catch (error) {
      next(error);
    }
  };

  listReceipts = (req, res, next) => {
    try {
      res.status(200).json(this.purchasingService.listReceipts(req.query));
    } catch (error) {
      next(error);
    }
  };

  getReceipt = (req, res, next) => {
    try {
      res.status(200).json({ data: this.purchasingService.getReceipt(Number(req.params.id)) });
    } catch (error) {
      next(error);
    }
  };

  createReceipt = (req, res, next) => {
    try {
      res
        .status(201)
        .json({ data: this.purchasingService.createReceipt(req.body || {}, req.user?.id) });
    } catch (error) {
      next(error);
    }
  };

  getSupplierLedger = (req, res, next) => {
    try {
      res
        .status(200)
        .json(this.purchasingService.getSupplierLedger(Number(req.params.supplierId), req.query));
    } catch (error) {
      next(error);
    }
  };
}
