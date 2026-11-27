export const HealthState = {
  HEALTHY: 'HEALTHY',
  FAILED: 'FAILED',
};

export class HealthStatus {
  constructor(status, errors = [], timestamp = new Date().toISOString()) {
    this.status = status;
    this.errors = errors;
    this.timestamp = timestamp;
  }
}

export class IntegrityCheckService {
  /** SQLite's structural check (quick_check at startup, integrity_check otherwise). */
  static check(db, quick = false) {
    const pragma = quick ? 'quick_check' : 'integrity_check';
    try {
      const results = db.pragma(pragma, { simple: false }).map((row) => Object.values(row)[0]);
      return results.length === 1 && results[0] === 'ok'
        ? new HealthStatus(HealthState.HEALTHY)
        : new HealthStatus(HealthState.FAILED, results);
    } catch (error) {
      return new HealthStatus(HealthState.FAILED, [error.message]);
    }
  }
}
