import { localDate } from '../../shared/utils/local-date.js';
import { AppError } from '../../shared/errors/app-error.js';
import { CrmRepository } from './crm.repository.js';

/** Service reminders: follow up with a customer when their car is due. */
export class CrmService {
  constructor(db) {
    this.repository = new CrmRepository(db);
  }

  createReminderForVehicle(payload = {}) {
    const vehicle = this.repository.getVehicle(Number(payload.vehicleId));
    if (!vehicle) throw new AppError('Vehicle not found.', 404, 'VEHICLE_NOT_FOUND');
    const date = payload.dueDate;
    if (
      typeof date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T12:00:00`)) ||
      localDate(new Date(`${date}T12:00:00`)) !== date
    )
      throw new AppError('A valid reminder date is required.', 400, 'VALIDATION_ERROR');
    if (!['MAINTENANCE', 'WARRANTY_EXPIRY', 'GENERAL_CHECKUP'].includes(payload.reminderType))
      throw new AppError('Choose a valid reminder type.', 400, 'VALIDATION_ERROR');
    if (
      payload.notes !== undefined &&
      (typeof payload.notes !== 'string' || payload.notes.length > 1000)
    )
      throw new AppError('Notes must be text up to 1000 characters.', 400, 'VALIDATION_ERROR');
    return this.repository.createReminder({
      customerId: vehicle.customer_id,
      vehicleId: vehicle.id,
      reminderType: payload.reminderType,
      dueDate: date,
      notes: payload.notes?.trim() || '',
    });
  }
  listReminders() {
    const today = localDate();
    return this.repository.getPendingReminders(today);
  }

  dismissReminder(id) {
    if (!this.repository.getReminder(id))
      throw new AppError('Reminder not found.', 404, 'REMINDER_NOT_FOUND');
    this.repository.updateReminderStatus(id, 'DISMISSED');
  }
}
export function createCrmService(db) {
  return new CrmService(db);
}
