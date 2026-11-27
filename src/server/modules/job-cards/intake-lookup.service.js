import { AppError } from '../../shared/errors/app-error.js';
import { addMonths, localDateOf } from '../../shared/utils/local-date.js';

// Phone digits only, as SQL: drops spaces, dashes, plus signs, brackets and dots.
const PHONE_DIGITS = `replace(replace(replace(replace(replace(replace(phone,' ',''),'-',''),'+',''),'(',''),')',''),'.','')`;

/** Digits of a phone typed any way, without a +91 or 0 prefix. */
export function localPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/** Registration number letters and digits only, upper case: "hr-26 ab 1234" -> "HR26AB1234". */
export function normalizeRegistration(registration) {
  return String(registration)
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
}

/**
 * New job card lookups: a returning customer by phone and a known vehicle by
 * registration number, with its service history in short.
 */
export class IntakeLookupService {
  constructor(db) {
    this.db = db;
  }

  /** The customer row whose phone matches (last 10 digits for a mobile number). */
  customerRowByPhone(phone) {
    const local = localPhone(phone);
    return this.db
      .prepare(
        local.length === 10
          ? `SELECT * FROM customers WHERE substr(${PHONE_DIGITS}, -10) = ?`
          : `SELECT * FROM customers WHERE ${PHONE_DIGITS} = ?`,
      )
      .get(local);
  }

  /** The vehicle row for a normalized registration number. */
  vehicleRow(normalized) {
    return this.db
      .prepare(
        `SELECT * FROM vehicles
         WHERE registration_number_normalized = @reg
            OR upper(replace(replace(replace(replace(registration_number,' ',''),'-',''),'_',''),'/','')) = @reg`,
      )
      .get({ reg: normalized });
  }

  /** Customer and vehicles for a phone typed any way (+91, 0, spaces); null when new. */
  findCustomerByPhone(phone) {
    if (!phone) throw new AppError('phone is required.', 400, 'VALIDATION_ERROR');
    const customer = this.customerRowByPhone(phone);
    if (!customer) return null;
    const vehicles = this.db
      .prepare('SELECT * FROM vehicles WHERE customer_id = ?')
      .all(customer.id);
    return { ...customer, vehicles };
  }

  /** Vehicle, owner and service summary for a registration typed any way; null when new. */
  findVehicleByRegistration(registration) {
    if (!registration)
      throw new AppError('registration_number is required.', 400, 'VALIDATION_ERROR');
    const normalized = normalizeRegistration(registration);
    const vehicle = this.db
      .prepare(
        `SELECT v.*, c.name AS customer_name, c.phone AS customer_phone,
           c.address AS customer_address, c.city AS customer_city, c.notes AS customer_notes,
           (SELECT COUNT(*) FROM vehicles WHERE customer_id = c.id) AS customer_vehicle_count,
           (SELECT COUNT(*) FROM job_cards WHERE customer_id = c.id) AS customer_job_card_count,
           (SELECT MAX(opened_at) FROM job_cards WHERE customer_id = c.id) AS customer_last_visit_at
         FROM vehicles v JOIN customers c ON c.id = v.customer_id
         WHERE v.registration_number_normalized = @reg
            OR upper(replace(replace(replace(replace(v.registration_number,' ',''),'-',''),'_',''),'/','')) = @reg`,
      )
      .get({ reg: normalized });
    if (!vehicle) return null;

    const totalJobCards = this.db
      .prepare('SELECT COUNT(*) AS count FROM job_cards WHERE vehicle_id = ?')
      .get(vehicle.id).count;
    const lastJobCard = this.db
      .prepare('SELECT * FROM job_cards WHERE vehicle_id = ? ORDER BY id DESC LIMIT 1')
      .get(vehicle.id);
    const outstandingBalance = this.db
      .prepare(
        `SELECT COALESCE(SUM(MAX(0, grand_total - amount_paid - COALESCE((
           SELECT SUM(total_refund_amount) FROM customer_returns
           WHERE invoice_id = invoices.id AND status = 'COMPLETED'), 0))), 0) AS balance
         FROM invoices WHERE vehicle_id = ? AND status = 'FINALIZED'`,
      )
      .get(vehicle.id).balance;

    const lastServiceDate = lastJobCard ? lastJobCard.closed_at || lastJobCard.opened_at : null;
    const lastOdometer = lastJobCard ? lastJobCard.odometer_reading : vehicle.odometer_reading;
    return {
      ...vehicle,
      vehicleStats: {
        lastServiceDate,
        lastOdometer,
        // Next service: six months or 5,000 km after the last visit.
        nextServiceDate: lastServiceDate ? addMonths(localDateOf(lastServiceDate), 6) : null,
        nextServiceOdometer: lastOdometer + 5000,
        totalJobCards,
        lastComplaint: lastJobCard ? lastJobCard.complaint : null,
        outstandingBalance,
      },
    };
  }
}
