import { respond } from '../../shared/http/respond.js';
export class ProfitController {
  constructor(profitService) {
    this.profitService = profitService;
  }

  tallyExport = respond((req, res) => {
    const xml = this.profitService.tallyExport(req.query);
    res.attachment('tally_export.xml').type('application/xml').send(xml);
  });
}
