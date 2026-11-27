import { respond, respondData } from '../../shared/http/respond.js';

export class TechnicianController {
  constructor(technicianService) {
    this.technicianService = technicianService;
  }

  list = respond((req) => this.technicianService.list(req.query));

  get = respondData((req) => this.technicianService.get(Number(req.params.id)));

  create = respondData((req) => this.technicianService.create(req.body || {}, req.user?.id), 201);

  update = respondData((req) =>
    this.technicianService.update(Number(req.params.id), req.body || {}, req.user?.id),
  );

  deactivate = respondData((req) =>
    this.technicianService.deactivate(Number(req.params.id), req.user?.id),
  );

  assignToJobCard = respondData((req) => {
    const { jobCardId, notes } = req.body || {};
    return this.technicianService.assignToJobCard(
      Number(jobCardId),
      Number(req.params.id),
      req.user?.id,
      notes,
    );
  });

  getHistory = respond((req) =>
    this.technicianService.getHistoryAndMetrics(Number(req.params.id), req.query),
  );
}
