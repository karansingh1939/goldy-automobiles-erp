import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from './database/connection.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AuthRepository } from './modules/auth/auth.repository.js';
import { createExpenseRouter } from './modules/expenses/expense.routes.js';
import { createInventoryRouter } from './modules/inventory/inventory.routes.js';
import { createJobCardRouter } from './modules/job-cards/job-card.routes.js';
import { registerMasterRoutes } from './modules/masters/master.routes.js';
import { createProfitRouter } from './modules/profit/profit.routes.js';
import { createPurchasingRouter } from './modules/purchasing/purchasing.routes.js';
import { createDashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { createGstRouter } from './modules/gst/gst.routes.js';
import { createServiceHistoryRouter } from './modules/service-history/service-history.routes.js';
import { createBackupRouter } from './modules/backup/backup.routes.js';
import { createTechnicianRouter } from './modules/technicians/technician.routes.js';
import { createAuditRouter } from './modules/audit/audit.routes.js';
import { createAccountingRouter } from './modules/accounting/accounting.routes.js';
import { createReturnsRouter } from './modules/returns/returns.routes.js';
import { createWarrantyRouter } from './modules/warranties/warranty.routes.js';
import { createCrmRouter } from './modules/crm/crm.routes.js';
import { createWorkshopRouter } from './modules/workshop/workshop.routes.js';
import { createCompanySettingsRouter } from './modules/settings/company-settings.js';
import { createStaffPayRouter } from './modules/staff-pay/staff-pay.routes.js';
import { errorHandler, notFoundHandler } from './shared/middleware/error-handler.js';
import { localHostGuard } from './shared/middleware/local-host-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../dist/renderer');

export function createApp({ db: rawDb = getDatabase(), backupScheduler } = {}) {
  const isGlobalDb = rawDb === getDatabase();

  const db = new Proxy(
    {},
    {
      get(target, prop) {
        const activeDb = isGlobalDb ? getDatabase() : rawDb;
        const value = Reflect.get(activeDb, prop);
        return typeof value === 'function' ? value.bind(activeDb) : value;
      },
      set(target, prop, value) {
        const activeDb = isGlobalDb ? getDatabase() : rawDb;
        return Reflect.set(activeDb, prop, value);
      },
    },
  );

  const app = express();

  app.disable('x-powered-by');
  app.use(localHostGuard());

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  const authService = new AuthService(new AuthRepository(db));

  // Pages other than the app shell (the printable job card) need a signed-in session cookie.
  app.use((req, res, next) => {
    if (!req.path.endsWith('.html') || req.path === '/index.html') return next();
    const token = /goldy_session_token=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    let user = null;
    try {
      user = token ? authService.getUserByToken(token) : null;
    } catch {
      // an expired or unknown token counts as signed out
    }
    if (!user) return res.redirect('/index.html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return next();
  });
  app.use(express.static(publicDir));

  app.get('/api/v1/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/api/v1/settings/company', createCompanySettingsRouter(db));
  app.use('/api/v1/auth', createAuthRouter(db));
  app.use('/api/v1/expenses', createExpenseRouter(db));
  app.use('/api/v1/inventory', createInventoryRouter(db));
  app.use('/api/v1/profit', createProfitRouter(db));
  app.use('/api/v1/dashboard', createDashboardRouter(db));
  app.use('/api/v1/gst', createGstRouter(db));
  app.use('/api/v1/backups', createBackupRouter(db, backupScheduler));
  app.use('/api/v1/technicians', createTechnicianRouter(db));
  app.use('/api/v1/staff-pay', createStaffPayRouter(db));
  app.use('/api/v1/audit-logs', createAuditRouter(db));
  app.use('/api/v1', createServiceHistoryRouter(db));
  app.use('/api/v1', createJobCardRouter(db));
  app.use('/api/v1/purchases', createPurchasingRouter(db));
  app.use('/api/v1/accounting', createAccountingRouter(db));
  app.use('/api/v1/returns', createReturnsRouter(db));
  app.use('/api/v1/warranties', createWarrantyRouter(db));
  app.use('/api/v1/crm', createCrmRouter(db));
  app.use('/api/v1/workshop', createWorkshopRouter(db));
  registerMasterRoutes(app, db);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
