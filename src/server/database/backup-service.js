import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { localDate } from '../shared/utils/local-date.js';

export function getBackupDirectory(dbPath) {
  const resolved = path.resolve(dbPath);
  const identity = createHash('sha256')
    .update(process.platform === 'win32' ? resolved.toLowerCase() : resolved)
    .digest('hex')
    .slice(0, 16);
  return path.join(
    path.dirname(resolved),
    '..',
    'backups',
    `${path.basename(resolved).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${identity}`,
  );
}

export function isManagedBackup(filePath, directory) {
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== path.resolve(directory)) return false;
  if (!/\.db$|\.sqlite$/i.test(resolved)) return false;
  if (!fs.existsSync(directory)) return false;
  if (fs.realpathSync(path.dirname(resolved)) !== fs.realpathSync(directory)) return false;
  return !fs.existsSync(resolved) || !fs.lstatSync(resolved).isSymbolicLink();
}

/** Local date and time as YYYY-MM-DD_HH-mm-ss, so file names sort by age. */
function stamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${localDate(now)}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

const KEEP_BACKUPS = 30;

/**
 * Startup safety copies: one silent copy a day and one before every upgrade,
 * kept in the database's own backups folder (newest 30 kept).
 */
export class BackupService {
  constructor(db) {
    if (!db) throw new Error('Database connection is required for BackupService');
    this.db = db;
  }

  /** This database's backups folder; null for an in-memory database. */
  backupsDir() {
    const dbPath = this.db.name;
    return !dbPath || dbPath === ':memory:' ? null : getBackupDirectory(dbPath);
  }

  /** Copies the database (including committed WAL pages); null for an in-memory database. */
  createBackup({ label = 'BACKUP' } = {}) {
    const dir = this.backupsDir();
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `goldy_backup_${stamp()}_${label.replace(/[^a-zA-Z0-9_-]/g, '_')}_${randomUUID()}.db`,
    );
    this.db.prepare('VACUUM INTO ?').run(file);
    return file;
  }

  /** Throws unless the file is a non-empty SQLite database that passes integrity_check. */
  verifyBackup(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`Backup file does not exist: ${filePath}`);
    if (fs.statSync(filePath).size === 0) throw new Error(`Backup file is empty: ${filePath}`);
    let copy;
    try {
      copy = new Database(filePath, { readonly: true });
      const result = copy.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error(`Integrity check failed: ${result || 'corrupted'}`);
      return true;
    } catch (err) {
      throw new Error(`Backup SQLite integrity verification failed: ${err.message}`);
    } finally {
      copy?.close();
    }
  }

  /** Deletes all but the newest 30 startup copies. */
  enforceRetentionPolicy() {
    const dir = this.backupsDir();
    if (!dir || !fs.existsSync(dir)) return;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('goldy_backup_') && isManagedBackup(path.join(dir, f), dir))
      .sort(); // names start with the date and time, so this is oldest first
    for (const file of files.slice(0, -KEEP_BACKUPS)) {
      try {
        fs.rmSync(path.join(dir, file), { force: true });
      } catch (err) {
        console.warn(`Failed to clean up old backup file ${file}:`, err.message);
      }
    }
  }

  /** Makes today's silent copy unless a valid one already exists. */
  checkAndRunDailyBackup() {
    const dir = this.backupsDir();
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    const todayPrefix = `goldy_backup_${localDate()}`;
    const hasDailyBackup = fs.readdirSync(dir).some((f) => {
      const file = path.join(dir, f);
      if (!f.startsWith(todayPrefix) || !isManagedBackup(file, dir)) return false;
      try {
        return this.verifyBackup(file);
      } catch {
        return false;
      }
    });
    if (hasDailyBackup) return;
    try {
      const backupPath = this.createBackup({ label: 'DAILY' });
      this.verifyBackup(backupPath);
      this.enforceRetentionPolicy();
      console.log(`Automatic daily silent backup created successfully at: ${backupPath}`);
    } catch (err) {
      console.error('Automatic daily silent backup failed:', err.message);
    }
  }
}
