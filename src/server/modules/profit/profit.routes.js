import { Router } from 'express';
import { createAuthService } from '../auth/auth.routes.js';
import { authenticate, requirePermission } from '../../shared/middleware/auth-middleware.js';
import { ProfitController } from './profit.controller.js';
import { createProfitService } from './profit.service.js';

export function createProfitRouter(db) {
  const router = Router();
  const authService = createAuthService(db);
  const controller = new ProfitController(createProfitService(db));
  const requireAuth = authenticate(authService);

  router.use(requireAuth);

  router.get('/tally-export', requirePermission('tally.export'), controller.tallyExport);

  router.use(requirePermission('profit.read'));

  return router;
}
