import { Router } from 'express';
import { createAuthService } from '../auth/auth.routes.js';
import { authenticate, requirePermission } from '../../shared/middleware/auth-middleware.js';
import { StaffPayService } from './staff-pay.service.js';
import { respondData } from '../../shared/http/respond.js';

export function createStaffPayRouter(db) {
  const router = Router();
  const service = new StaffPayService(db);
  router.use(authenticate(createAuthService(db)));

  router.get(
    '/',
    requirePermission('accounting.read'),
    respondData((req) => service.summary(req.query.month)),
  );
  router.patch(
    '/:id/salary',
    requirePermission('accounting.write'),
    respondData((req) => service.setMonthlySalary(req.params.id, req.body, req.user.id)),
  );
  router.post(
    '/:id/advance',
    requirePermission('accounting.write'),
    respondData((req) => service.giveAdvance(req.params.id, req.body, req.user.id), 201),
  );
  router.post(
    '/:id/pay',
    requirePermission('accounting.write'),
    respondData((req) => service.paySalary(req.params.id, req.body, req.user.id), 201),
  );
  return router;
}
