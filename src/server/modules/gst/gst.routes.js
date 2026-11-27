import { Router } from 'express';
import { createAuthService } from '../auth/auth.routes.js';
import { authenticate, requirePermission } from '../../shared/middleware/auth-middleware.js';
import { GstController } from './gst.controller.js';
import { createGstService } from './gst.service.js';
import { Gstr1ExportService, SECTIONS } from './gstr1-export.service.js';
import { respond } from '../../shared/http/respond.js';

export function createGstRouter(db) {
  const router = Router();
  const controller = new GstController(createGstService(db));
  router.use(authenticate(createAuthService(db)), requirePermission('gst.read'));

  router.get('/summary', controller.summary);
  router.get('/gstr1', controller.gstr1);
  router.get('/gstr3b', controller.gstr3b);
  router.get('/hsn-summary', controller.hsnSummary);

  // GSTR-1 files for the CA (CSV opens in Excel)
  const gstr1Export = new Gstr1ExportService(db);
  router.get(
    '/gstr1-export',
    respond((req) => {
      const built = gstr1Export.build(req.query);
      return {
        filters: built.filters,
        data: Object.fromEntries(Object.keys(SECTIONS).map((key) => [key, built[key]])),
      };
    }),
  );
  router.get(
    '/gstr1-export/:section.csv',
    respond((req, res) => {
      const body = gstr1Export.csv(req.params.section, req.query);
      const from = String(req.query.dateFrom || req.query.from || '').replaceAll('-', '');
      res
        .type('text/csv; charset=utf-8')
        .attachment(`GSTR1_${req.params.section}_${from || 'period'}.csv`)
        .send(body);
    }),
  );

  return router;
}
