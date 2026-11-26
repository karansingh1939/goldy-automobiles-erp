export class CrmController {
  constructor(crmService) {
    this.crmService = crmService;
  }

  listReminders = (req, res, next) => {
    try {
      const result = this.crmService.listReminders();
      res.status(200).json({ status: 'success', data: result });
    } catch (error) {
      next(error);
    }
  };
  createReminder = (req, res, next) => {
    try {
      res.status(201).json({ data: this.crmService.createReminderForVehicle(req.body) });
    } catch (error) {
      next(error);
    }
  };

  dismissReminder = (req, res, next) => {
    try {
      this.crmService.dismissReminder(Number(req.params.id));
      res.status(200).json({ status: 'success', message: 'Reminder dismissed.' });
    } catch (error) {
      next(error);
    }
  };
}
