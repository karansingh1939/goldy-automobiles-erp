import { respond } from '../../shared/http/respond.js';

/**
 * Controller layer for the Vehicle Service History module.
 * Maps incoming HTTP requests to the business service layer.
 */
export class ServiceHistoryController {
  /**
   * @param {import('./service-history.service.js').ServiceHistoryService} serviceHistoryService - The injected service.
   */
  constructor(serviceHistoryService) {
    this.serviceHistoryService = serviceHistoryService;
  }

  /**
   * Handles GET /api/v1/vehicles/:vehicleId/service-history
   */
  getVehicleServiceHistory = respond((req) => {
    const vehicleId = Number(req.params.vehicleId);
    const result = this.serviceHistoryService.getVehicleServiceHistory(vehicleId);
    return result;
  });
}
