import { Router } from 'express';
import { respondData } from '../../shared/http/respond.js';
import { IntakeLookupService } from './intake-lookup.service.js';
import { createAuthService } from '../auth/auth.routes.js';
import { authenticate, requirePermission } from '../../shared/middleware/auth-middleware.js';
import { JobCardController } from './job-card.controller.js';
import { createJobCardService } from './job-card.service.js';

export function createJobCardRouter(db) {
  const router = Router();
  const controller = new JobCardController(createJobCardService(db));
  router.use(authenticate(createAuthService(db)));

  const lookups = new IntakeLookupService(db);
  router.get(
    '/customers/lookup',
    requirePermission('job_cards.read'),
    respondData((req) => lookups.findCustomerByPhone(req.query.phone)),
  );
  router.get(
    '/vehicles/lookup',
    requirePermission('job_cards.read'),
    respondData((req) => lookups.findVehicleByRegistration(req.query.registration_number)),
  );

  router.get('/job-cards', requirePermission('job_cards.read'), controller.list);
  router.get('/job-cards/:id', requirePermission('job_cards.read'), controller.get);
  router.post('/job-cards', requirePermission('job_cards.write'), controller.create);
  router.post('/job-cards/:id/parts', requirePermission('job_cards.write'), controller.addPart);
  router.post('/job-cards/:id/labour', requirePermission('job_cards.write'), controller.addLabour);
  router.delete(
    '/job-cards/:id/:kind(parts|labour)/:lineId',
    requirePermission('job_cards.write'),
    controller.removeLine,
  );
  router.post('/job-cards/:id/cancel', requirePermission('job_cards.write'), controller.cancel);
  router.post(
    '/job-cards/:id/finalize',
    requirePermission('invoices.finalize'),
    controller.finalize,
  );

  router.get('/invoices/:id', requirePermission('invoices.read'), controller.getInvoice);
  router.post(
    '/invoices/:id/cancel',
    requirePermission('invoices.cancel'),
    controller.cancelInvoice,
  );

  return router;
}
