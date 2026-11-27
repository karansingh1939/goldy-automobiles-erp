import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { DbSafetyService } from './db-safety-service.js';
import { IntegrityCheckService, HealthState } from './integrity-check-service.js';
import { AppError } from '../shared/errors/app-error.js';
import { CorruptionRecoveryService } from './corruption-recovery-service.js';
import { recoverOrphanBackupLock } from './backup-lock.js';

let activeDatabase = null;

/** The data folder and its sibling backups and logs folders. */
function ensureRequiredDirectories(dbPath) {
  const dbDir = path.dirname(dbPath);
  for (const dir of [dbDir, path.join(dbDir, '..', 'backups'), path.join(dbDir, '..', 'logs')])
    fs.mkdirSync(dir, { recursive: true });
}

/** Opens the file with the app's settings and refuses it if the quick integrity check fails. */
function openChecked(resolvedPath) {
  const db = new Database(resolvedPath);
  try {
    // Wait for a busy file before anything else, including the WAL switch.
    db.pragma('busy_timeout = 10000');
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    DbSafetyService.verifyConfiguration(db);
    const health = IntegrityCheckService.check(db, true);
    if (health.status === HealthState.FAILED) {
      const error = new AppError(
        `Database integrity check failed: ${health.errors.join('; ')}`,
        500,
        'DATABASE_CORRUPTION',
      );
      error.diagnostics = health;
      throw error;
    }
    return db;
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

export function createDatabase(filePath = env.dbFile, { allowRestoreLock = false } = {}) {
  const resolvedPath = path.resolve(filePath);
  if (!allowRestoreLock && fs.existsSync(path.join(path.dirname(resolvedPath), 'restore.lock'))) {
    throw new AppError(
      'An interrupted restore requires administrator recovery. Preserve the database and rollback files before removing restore.lock.',
      500,
      'DATABASE_MAINTENANCE_PENDING',
    );
  }
  ensureRequiredDirectories(resolvedPath);
  recoverOrphanBackupLock(resolvedPath);

  try {
    return openChecked(resolvedPath);
  } catch (error) {
    const isCorruption =
      error.message.includes('file is not a database') ||
      error.message.includes('database disk image is malformed') ||
      error.code === 'SQLITE_CORRUPT' ||
      error.message.includes('integrity check failed');

    if (isCorruption) {
      const health = {
        status: 'FAILED',
        errors: [error.message],
        timestamp: new Date().toISOString(),
      };

      // 1. Execute recovery callback or use fallback service
      let recoveryResult = null;
      if (global.onDatabaseCorruption) {
        try {
          recoveryResult = global.onDatabaseCorruption(resolvedPath, health);
        } catch (recoveryErr) {
          throw new AppError(
            `Database recovery hook failed: ${recoveryErr.message}`,
            500,
            'DATABASE_RECOVERY_FAILED',
          );
        }
      } else {
        recoveryResult = CorruptionRecoveryService.recover(resolvedPath);
      }

      // 2. If recovery succeeded, re-attempt connecting to recovered database
      if (recoveryResult?.status === 'SUCCESS') {
        try {
          return openChecked(resolvedPath);
        } catch (retryError) {
          const appErr = new AppError(
            `Database connection failed after recovery: ${retryError.message}`,
            500,
            'DATABASE_RECOVERY_FAILED',
          );
          appErr.diagnostics = { recoveryResult, retryError: retryError.message };
          throw appErr;
        }
      }

      // Recovery failed
      const recoveryInstructions =
        `RECOVERY INSTRUCTIONS:\n` +
        `1. Locate the backups folder (typically sibling to your 'data' folder: %APPDATA%/Goldy_Automobiles/backups).\n` +
        `2. Identify the latest valid backup file (e.g. goldy_erp_backup_YYYYMMDD.db).\n` +
        `3. Verify it is not empty (size > 0).\n` +
        `4. Rename it to 'goldy_erp.db' and copy it to the 'data' directory.\n` +
        `5. Restart the application. If the problem persists, contact administrator/technical support.`;

      const errorMsg = `Database corruption detected: ${error.message}. Recovery failed: ${recoveryResult ? recoveryResult.errors.join('; ') : 'No recovery strategy succeeded'}.\n\n${recoveryInstructions}`;
      const corrError = new AppError(errorMsg, 500, 'DATABASE_RECOVERY_FAILED');
      corrError.diagnostics = { health, recoveryResult };
      corrError.recoveryInstructions = recoveryInstructions;
      throw corrError;
    }

    throw error;
  }
}

const dbDir = path.dirname(env.dbFile);
const dbExt = path.extname(env.dbFile);
const dbBase = path.basename(env.dbFile, dbExt);
// Very old versions had a demo-mode switch that moved the app onto this file.
// If that setting is still on, keep opening it so no entered data is hidden.
export const demoDbFile = path.join(dbDir, `${dbBase}_demo${dbExt}`);
const configFilePath = path.join(dbDir, 'setup', 'app_config.json');

function readAppConfig() {
  try {
    if (fs.existsSync(configFilePath)) {
      const config = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      if (
        !config ||
        typeof config !== 'object' ||
        Array.isArray(config) ||
        (config.demoMode !== undefined && typeof config.demoMode !== 'boolean')
      ) {
        throw new Error('Invalid application mode configuration.');
      }
      return config;
    }
  } catch (err) {
    throw new AppError(
      `Cannot read application mode configuration: ${err.message}`,
      500,
      'CONFIG_READ_FAILED',
    );
  }
  return { demoMode: false };
}

const configuredDatabasePath = () => (readAppConfig().demoMode ? demoDbFile : env.dbFile);

export function getDatabase() {
  activeDatabase ||= createDatabase(configuredDatabasePath());
  return activeDatabase;
}

export function closeDatabase() {
  if (activeDatabase) {
    activeDatabase.close();
    activeDatabase = null;
  }
}

export function reopenDatabase(filePath = null, { allowRestoreLock = false } = {}) {
  closeDatabase();
  activeDatabase = createDatabase(filePath || configuredDatabasePath(), { allowRestoreLock });
  return activeDatabase;
}

/** Removes the -wal and -shm side files of a closed database. */
export function cleanupWalFiles(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(`${path.resolve(dbPath)}${suffix}`, { force: true });
    } catch (err) {
      console.warn(`Failed to clean up ${suffix} file: ${err.message}`);
    }
  }
}
