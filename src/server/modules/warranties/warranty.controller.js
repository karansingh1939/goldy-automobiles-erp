import { WarrantyService } from './warranty.service.js';
import { respond, respondData } from '../../shared/http/respond.js';
import { AppError } from '../../shared/errors/app-error.js';

export class WarrantyController {
  constructor(db) {
    this.service = new WarrantyService(db);
  }

  registerWarranty = respond((req) => {
    const data = this.service.registerWarranty(req.body);
    return { data };
  }, 201);

  fileClaim = respond((req) => {
    const data = this.service.fileClaim(req.body, req.user?.id || 1);
    return { data };
  }, 201);

  settleClaim = respond((req) => {
    const data = this.service.settleClaim(Number(req.params.id), req.body, req.user?.id || 1);
    return { data };
  });

  rejectClaim = respond((req) => {
    const data = this.service.rejectClaim(Number(req.params.id), req.body, req.user?.id || 1);
    return { data };
  });

  getWarrantyRegistrationById = respondData((req) => {
    const data = this.service.repository.findWarrantyRegistrationById(Number(req.params.id));
    if (!data) throw new AppError('Warranty registration not found.', 404, 'NOT_FOUND');
    return data;
  });

  listWarrantyRegistrations = respond((req) => {
    const query = {
      companyId: req.query.companyId ? Number(req.query.companyId) : 1,
      customerId: req.query.customerId ? Number(req.query.customerId) : undefined,
      vehicleId: req.query.vehicleId ? Number(req.query.vehicleId) : undefined,
      itemId: req.query.itemId ? Number(req.query.itemId) : undefined,
      status: req.query.status,
    };
    const data = this.service.repository.listWarrantyRegistrations(query);
    return { data };
  });

  listWarrantyClaims = respond((req) => {
    const query = {
      companyId: req.query.companyId ? Number(req.query.companyId) : 1,
      status: req.query.status,
    };
    const data = this.service.repository.listWarrantyClaims(query);
    return { data };
  });
}
