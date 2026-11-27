import { AppError } from '../shared/errors/app-error.js';

// Settings every connection must have: foreign keys on, WAL journal, NORMAL
// sync (1) and a 10 second wait when the file is busy.
const REQUIRED = [
  ['foreign_keys', 1],
  ['journal_mode', 'wal'],
  ['synchronous', 1],
  ['busy_timeout', 10000],
];

export class DbSafetyService {
  /** Throws DATABASE_CONFIG_ERROR when a connection lacks a required setting. */
  static verifyConfiguration(db) {
    for (const [name, expected] of REQUIRED) {
      let actual;
      try {
        actual = db.pragma(name, { simple: true });
      } catch (error) {
        throw new AppError(
          `SQLite safety validation failed: ${error.message}`,
          500,
          'DATABASE_CONFIG_ERROR',
        );
      }
      if (String(actual) !== String(expected))
        throw new AppError(
          `SQLite ${name} is "${actual}" (expected "${expected}").`,
          500,
          'DATABASE_CONFIG_ERROR',
        );
    }
  }
}
