import { parsePaging } from '../../shared/utils/validation.js';
import { respond, respondData } from '../../shared/http/respond.js';

export class MasterController {
  constructor(masterService) {
    this.masterService = masterService;
  }

  list = respond((req) => this.masterService.list(parsePaging(req.query)));

  get = respondData((req) => this.masterService.get(Number(req.params.id)));

  create = respondData((req) => this.masterService.create(req.body || {}, req.user?.id), 201);

  update = respondData((req) =>
    this.masterService.update(Number(req.params.id), req.body || {}, req.user?.id),
  );

  delete = respond((req) => this.masterService.delete(Number(req.params.id), req.user?.id));
}
