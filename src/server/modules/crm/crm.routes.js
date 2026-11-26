import { Router } from 'express';
import { createAuthService } from '../auth/auth.routes.js';
import { authenticate, requirePermission } from '../../shared/middleware/auth-middleware.js';
import { CrmController } from './crm.controller.js';
import { createCrmService } from './crm.service.js';

export function createCrmRouter(db) {
  const router = Router();
  const authService = createAuthService(db);
  const controller = new CrmController(createCrmService(db));
  const requireAuth = authenticate(authService);

  router.use(requireAuth);

  // Reminders endpoints
  router.get('/reminders', requirePermission('customers.read'), controller.listReminders);
  router.post('/reminders', requirePermission('customers.write'), controller.createReminder);
  router.post(
    '/reminders/:id/dismiss',
    requirePermission('customers.write'),
    controller.dismissReminder,
  );

  return router;
}
