import { respond, respondData } from '../../shared/http/respond.js';

export class ExpenseController {
  constructor(expenseService) {
    this.expenseService = expenseService;
  }

  list = respond((req) => this.expenseService.list(req.query));

  get = respondData((req) => this.expenseService.get(Number(req.params.id)));

  summary = respond((req) => this.expenseService.summary(req.query));

  create = respondData((req) => this.expenseService.create(req.body || {}, req.user?.id), 201);

  update = respondData((req) =>
    this.expenseService.update(Number(req.params.id), req.body || {}, req.user?.id),
  );

  delete = respond((req) => this.expenseService.delete(Number(req.params.id), req.user?.id));
}
