import { respond, respondData } from '../../shared/http/respond.js';

export class JobCardController {
  constructor(jobCardService) {
    this.jobCardService = jobCardService;
  }

  list = respond((req) => this.jobCardService.list(req.query));

  get = respond((req) => {
    const data = this.jobCardService.get(Number(req.params.id));
    return { data };
  });

  create = respondData((req) => this.jobCardService.create(req.body || {}, req.user?.id), 201);

  addPart = respondData(
    (req) => this.jobCardService.addPart(Number(req.params.id), req.body || {}, req.user?.id),
    201,
  );

  removeLine = respondData((req) =>
    this.jobCardService.removeLine(
      Number(req.params.id),
      req.params.kind,
      Number(req.params.lineId),
      req.user?.id,
    ),
  );

  cancel = respondData((req) =>
    this.jobCardService.cancelJobCard(Number(req.params.id), req.body?.reason, req.user?.id),
  );

  addLabour = respondData(
    (req) => this.jobCardService.addLabour(Number(req.params.id), req.body || {}, req.user?.id),
    201,
  );

  finalize = respondData(
    (req) => this.jobCardService.finalize(Number(req.params.id), req.user?.id),
    201,
  );

  getInvoice = respondData((req) => this.jobCardService.getInvoice(Number(req.params.id)));

  cancelInvoice = respondData((req) =>
    this.jobCardService.cancelInvoice(Number(req.params.id), req.user?.id),
  );
}
