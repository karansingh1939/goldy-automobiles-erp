import { respondData } from '../../shared/http/respond.js';

export class CrmController {
  constructor(crmService) {
    this.crmService = crmService;
  }

  listReminders = respondData(() => this.crmService.listReminders());
  createReminder = respondData((req) => this.crmService.createReminderForVehicle(req.body), 201);

  dismissReminder = respondData((req) => {
    this.crmService.dismissReminder(Number(req.params.id));
    return { dismissed: true };
  });
}
