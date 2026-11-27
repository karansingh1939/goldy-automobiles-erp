import { AppError } from './app-error.js';

/** Turns a SQLite constraint failure into a plain message; other errors pass through. */
export function fromDatabaseError(error, { deleting = false } = {}) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (!code.startsWith('SQLITE_CONSTRAINT')) return error;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE')
    return new AppError(
      'A record with the same unique value already exists.',
      409,
      'DUPLICATE_RECORD',
    );
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY')
    return deleting
      ? new AppError(
          'Cannot delete record because it is referenced by other records.',
          400,
          'RELATED_RECORD_EXISTS',
        )
      : new AppError('Related record was not found.', 400, 'RELATED_RECORD_NOT_FOUND');
  return new AppError('Record violates a database constraint.', 400, 'CONSTRAINT_FAILED');
}
