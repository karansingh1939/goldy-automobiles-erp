export class ProfitController {
  constructor(profitService) {
    this.profitService = profitService;
  }

  tallyExport = (req, res, next) => {
    try {
      const xml = this.profitService.tallyExport(req.query);
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', 'attachment; filename="tally_export.xml"');
      res.status(200).send(xml);
    } catch (error) {
      next(error);
    }
  };
}
