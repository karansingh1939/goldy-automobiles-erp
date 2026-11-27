import { parseAuditListQuery } from './audit.validator.js';
import { respond } from '../../shared/http/respond.js';

export class AuditController {
  constructor(auditService) {
    this.auditService = auditService;
  }

  list = respond((req) => {
    const filters = parseAuditListQuery(req.query);
    const result = this.auditService.list(filters);
    return {
      data: result.data,
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / filters.pageSize),
      },
    };
  });
}
