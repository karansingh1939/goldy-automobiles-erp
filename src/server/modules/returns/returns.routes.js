import { Router } from 'express';
import { createAuthService } from '../auth/auth.routes.js';
import { authenticate, requirePermission } from '../../shared/middleware/auth-middleware.js';
import { ReturnsController } from './returns.controller.js';

export function createReturnsRouter(db) {
  const router = Router();
  const authService = createAuthService(db);
  const controller = new ReturnsController(db);
  const requireAuth = authenticate(authService);

  router.use(requireAuth);

  // Customer Returns
  router.get('/customer', requirePermission('returns.read'), controller.listCustomerReturns);
  router.post('/customer', requirePermission('returns.write'), controller.createCustomerReturn);
  router.post(
    '/customer/:id/approve',
    requirePermission('returns.approve'),
    controller.completeCustomerReturn,
  );
  router.post(
    '/customer/:id/cancel',
    requirePermission('returns.approve'),
    controller.cancelCustomerReturn,
  );

  // Supplier Returns
  router.get('/supplier', requirePermission('returns.read'), controller.listSupplierReturns);
  router.post('/supplier', requirePermission('returns.write'), controller.createSupplierReturn);
  router.post(
    '/supplier/:id/approve',
    requirePermission('returns.approve'),
    controller.completeSupplierReturn,
  );
  router.post(
    '/supplier/:id/cancel',
    requirePermission('returns.approve'),
    controller.cancelSupplierReturn,
  );

  return router;
}
