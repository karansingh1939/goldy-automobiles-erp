import { respond } from '../../shared/http/respond.js';

export class GstController {
  constructor(gstService) {
    this.gstService = gstService;
  }

  summary = respond((req) => this.gstService.summary(req.query));

  gstr1 = respond((req) => this.gstService.gstr1(req.query));

  gstr3b = respond((req) => this.gstService.gstr3b(req.query));

  hsnSummary = respond((req) => this.gstService.hsnSummary(req.query));
}
