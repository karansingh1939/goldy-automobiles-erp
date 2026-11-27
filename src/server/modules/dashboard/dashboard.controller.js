import { respond } from '../../shared/http/respond.js';

export class DashboardController {
  constructor(dashboardService) {
    this.dashboardService = dashboardService;
  }

  getOperationsMetrics = respond((req) =>
    this.dashboardService.getOperationsMetrics(req.query.date),
  );

  getFinancialMetrics = respond((req) => this.dashboardService.getFinancialMetrics(req.query.date));

  getInventoryMetrics = respond(() => this.dashboardService.getInventoryMetrics());

  getSalesMetrics = respond((req) => this.dashboardService.getSalesMetrics(req.query.date));
}
