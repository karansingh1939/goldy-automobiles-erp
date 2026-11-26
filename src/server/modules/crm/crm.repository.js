export class CrmRepository {
  constructor(db) {
    this.db = db;
  }

  // Service reminders
  createReminder({ customerId, vehicleId, reminderType, dueDate, notes }) {
    const stmt = this.db.prepare(`
      INSERT INTO service_reminders (customer_id, vehicle_id, reminder_type, due_date, status, notes)
      VALUES (?, ?, ?, ?, 'PENDING', ?)
    `);
    const result = stmt.run(customerId, vehicleId, reminderType, dueDate, notes || null);
    return this.getReminder(result.lastInsertRowid);
  }

  getReminder(id) {
    return this.db.prepare('SELECT * FROM service_reminders WHERE id = ?').get(id);
  }
  getVehicle(id) {
    return this.db.prepare('SELECT * FROM vehicles WHERE id = ?').get(id);
  }

  getPendingReminders(asOfDate) {
    return this.db
      .prepare(
        `
      SELECT sr.*, 
             c.name AS customer_name, c.phone AS customer_phone,
             v.registration_number, v.make, v.model
      FROM service_reminders sr
      JOIN customers c ON sr.customer_id = c.id
      JOIN vehicles v ON sr.vehicle_id = v.id
      WHERE sr.status = 'PENDING' AND DATE(sr.due_date) <= DATE(?)
      ORDER BY sr.due_date ASC
    `,
      )
      .all(asOfDate);
  }

  updateReminderStatus(id, status) {
    this.db
      .prepare(
        `
      UPDATE service_reminders
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      )
      .run(status, id);
  }
}
