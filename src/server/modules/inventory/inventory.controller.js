import { respond, respondData } from '../../shared/http/respond.js';

export class InventoryController {
  constructor(inventoryService) {
    this.inventoryService = inventoryService;
  }

  listItems = respond((req) => this.inventoryService.listItems(req.query));

  getItem = respondData((req) => this.inventoryService.getItem(Number(req.params.id)));

  getItemBatches = respondData((req) =>
    this.inventoryService.getItemBatches(Number(req.params.id)),
  );

  createItem = respondData(
    (req) => this.inventoryService.createItem(req.body || {}, req.user?.id),
    201,
  );

  updateItem = respondData((req) =>
    this.inventoryService.updateItem(Number(req.params.id), req.body || {}, req.user?.id),
  );

  createOpeningStock = respondData(
    (req) => this.inventoryService.createOpeningStock(req.body || {}, req.user?.id),
    201,
  );

  createAdjustment = respondData(
    (req) => this.inventoryService.createAdjustment(req.body || {}, req.user?.id),
    201,
  );

  transferStock = respondData(
    (req) => this.inventoryService.transferStock(req.body || {}, req.user?.id),
    201,
  );

  stockSummary = respond(() => this.inventoryService.stockSummary());

  stockValuation = respond((req) => this.inventoryService.stockValuation(req.query));

  movements = respond((req) => this.inventoryService.movementReport(req.query));

  lowStock = respond(() => this.inventoryService.lowStockReport());

  seedStarter = respond(() => this.inventoryService.seedStarter());

  getSeedStatus = respond(() => this.inventoryService.getSeedStatus());

  listFixedAssets = respond((req) => this.inventoryService.listFixedAssets(req.query));

  createFixedAsset = respondData(
    (req) => this.inventoryService.createFixedAsset(req.body || {}, req.user?.id),
    201,
  );

  cancelFixedAsset = respondData((req) =>
    this.inventoryService.cancelFixedAsset(req.params.id, req.user?.id),
  );

  listStockVerifications = respond((req) =>
    this.inventoryService.listStockVerifications(req.query),
  );

  verifyStock = respondData(
    (req) => this.inventoryService.verifyStock(req.body || {}, req.user?.id),
    201,
  );

  dashboardStats = respond(() => this.inventoryService.dashboardStats());

  bulkSave = respondData((req) => this.inventoryService.bulkSave(req.body || {}, req.user?.id));

  approveVerification = respondData((req) =>
    this.inventoryService.approveVerification(Number(req.params.id), req.user?.id),
  );

  rejectVerification = respondData((req) =>
    this.inventoryService.rejectVerification(Number(req.params.id), req.user?.id),
  );
}
