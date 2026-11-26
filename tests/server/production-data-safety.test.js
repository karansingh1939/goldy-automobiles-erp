import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTestContext } from './helpers.js';
import { BackupService } from '../../src/server/modules/backup/backup.service.js';
import { BackupService as StartupBackupService } from '../../src/server/database/backup-service.js';
import { RestoreService } from '../../src/server/modules/restore/restore.service.js';
import { closeDatabase, createDatabase } from '../../src/server/database/connection.js';
import {
  CorruptionRecoveryService,
  RecoveryStatus,
} from '../../src/server/database/corruption-recovery-service.js';
import {
  IntegrityCheckService,
  HealthState,
} from '../../src/server/database/integrity-check-service.js';

test('maintenance routes reject non-admin even when granted backup permission', async () => {
  const context = await createTestContext();
  try {
    const role = context.db.prepare("SELECT id FROM roles WHERE name = 'Mechanic'").get();
    const admin = context.db
      .prepare("SELECT password_hash FROM users WHERE username = 'admin'")
      .get();
    context.db
      .prepare('INSERT INTO users (name, username, password_hash, role_id) VALUES (?, ?, ?, ?)')
      .run('Mechanic', 'maintenance-mechanic', admin.password_hash, role.id);
    context.db
      .prepare(
        `INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
      SELECT ?, id FROM permissions WHERE key = 'backups.write'`,
      )
      .run(role.id);
    const login = await context.request('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'maintenance-mechanic', password: 'Admin@12345' }),
    });
    for (const [endpoint, method] of [['backups/manual', 'POST']]) {
      const result = await context.request(`/api/v1/${endpoint}`, {
        method,
        headers: { Authorization: `Bearer ${login.body.token}` },
        ...(method === 'POST' ? { body: JSON.stringify({ enable: false, customers: [] }) } : {}),
      });
      assert.equal(result.response.status, 403, endpoint);
    }
  } finally {
    await context.close();
  }
});

test('startup backups and daily backup detection isolate database identities', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goldy-backup-isolation-'));
  fs.mkdirSync(path.join(directory, 'data'));
  const production = new Database(path.join(directory, 'data', 'goldy.sqlite'));
  const demo = new Database(path.join(directory, 'data', 'goldy_demo.sqlite'));
  try {
    production.exec('CREATE TABLE records (id INTEGER); INSERT INTO records VALUES (1)');
    demo.exec('CREATE TABLE records (id INTEGER); INSERT INTO records VALUES (2)');
    const demoBackup = new StartupBackupService(demo).createBackup({ label: 'DAILY' });
    const service = new StartupBackupService(production);
    service.checkAndRunDailyBackup();
    const productionBackup = service.createBackup();
    assert.notEqual(path.dirname(productionBackup), path.dirname(demoBackup));
    assert.ok(fs.readdirSync(path.dirname(productionBackup)).length >= 2);
  } finally {
    production.close();
    demo.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('retention never deletes a file outside the managed backup directory', async () => {
  const context = await createTestContext();
  const service = new BackupService(context.db);
  const outside = path.join(path.dirname(context.db.name), 'do-not-delete.txt');
  try {
    fs.writeFileSync(outside, 'production data');
    service.updateSettings({ 'backup.retention_count': 1 });
    service.repository.createBackupLog({
      filename: 'do-not-delete.txt',
      filepath: outside,
      type: 'AUTO',
      status: 'SUCCESS',
    });
    await service.backupDatabase({ type: 'AUTO', userId: 1 });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'production data');
  } finally {
    await context.close();
  }
});

test('restore includes committed source WAL rows and accepts a missing audit actor', async () => {
  const context = await createTestContext();
  const sourcePath = path.join(path.dirname(context.db.name), 'source-wal.sqlite');
  let source;
  const restore = new RestoreService(context.db, new BackupService(context.db));
  try {
    await context.db.backup(sourcePath);
    source = new Database(sourcePath);
    source.pragma('journal_mode = WAL');
    source.pragma('wal_autocheckpoint = 0');
    source.pragma('wal_checkpoint(TRUNCATE)');
    source.prepare("INSERT INTO customers (name) VALUES ('WAL customer')").run();
    const result = await restore.restoreDatabase({ backupFilePath: sourcePath, userId: 987654 });
    assert.equal(result.success, true);
    assert.equal(
      restore.db.prepare("SELECT name FROM customers WHERE name = 'WAL customer'").get().name,
      'WAL customer',
    );
    assert.equal(
      restore.db
        .prepare("SELECT created_by FROM restore_logs WHERE status = 'SUCCESS' ORDER BY id DESC")
        .get().created_by,
      null,
    );
  } finally {
    source?.close();
    closeDatabase();
    await context.close();
  }
});

test('restore rejects non-ERP SQLite before changing production', async () => {
  const context = await createTestContext();
  const sourcePath = path.join(path.dirname(context.db.name), 'unrelated.sqlite');
  try {
    context.db.prepare("INSERT INTO customers (name) VALUES ('Original customer')").run();
    const source = new Database(sourcePath);
    source.exec('CREATE TABLE unrelated (id INTEGER)');
    source.close();
    const restore = new RestoreService(context.db, new BackupService(context.db));
    await assert.rejects(
      restore.restoreDatabase({ backupFilePath: sourcePath, userId: 1 }),
      (err) => err.code === 'RESTORE_SCHEMA_INVALID',
    );
    assert.equal(
      context.db.prepare("SELECT name FROM customers WHERE name = 'Original customer'").get().name,
      'Original customer',
    );
  } finally {
    closeDatabase();
    await context.close();
  }
});

test('restore rejects a demo snapshot and an incomplete ERP schema without changing production', async () => {
  const context = await createTestContext();
  const sourcePath = path.join(path.dirname(context.db.name), 'demo.sqlite');
  try {
    await context.db.backup(sourcePath);
    let source = new Database(sourcePath);
    source
      .prepare("INSERT INTO system_settings (key, value) VALUES ('database.mode', 'demo')")
      .run();
    source.close();
    const restore = new RestoreService(context.db, new BackupService(context.db));
    await assert.rejects(
      restore.restoreDatabase({ backupFilePath: sourcePath }),
      (error) => error.code === 'RESTORE_MODE_MISMATCH',
    );
    source = new Database(sourcePath);
    source.exec(
      "DELETE FROM system_settings WHERE key = 'database.mode'; DROP TABLE customer_returns;",
    );
    source.close();
    await assert.rejects(
      restore.restoreDatabase({ backupFilePath: sourcePath }),
      (error) => error.code === 'RESTORE_SCHEMA_INVALID',
    );
    assert.equal(context.db.open, true);
  } finally {
    closeDatabase();
    await context.close();
  }
});

test('restore rolls back when the success audit write fails', async () => {
  const context = await createTestContext();
  const sourcePath = path.join(path.dirname(context.db.name), 'audit-failure.sqlite');
  const restore = new RestoreService(context.db, new BackupService(context.db));
  try {
    await context.db.backup(sourcePath);
    const source = new Database(sourcePath);
    source.exec(`CREATE TRIGGER fail_restore_audit BEFORE INSERT ON restore_logs
      WHEN NEW.status = 'SUCCESS' BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`);
    source.close();
    context.db
      .prepare("INSERT INTO customers (name) VALUES ('Original survives audit failure')")
      .run();
    await assert.rejects(
      restore.restoreDatabase({ backupFilePath: sourcePath, userId: 1 }),
      (error) => error.code === 'RESTORE_FAILED',
    );
    assert.equal(
      restore.db
        .prepare("SELECT name FROM customers WHERE name = 'Original survives audit failure'")
        .get().name,
      'Original survives audit failure',
    );
    assert.equal(
      restore.db.prepare('SELECT status FROM restore_logs ORDER BY id DESC').get().status,
      'FAILED',
    );
  } finally {
    closeDatabase();
    await context.close();
  }
});

test('a failed integrity scan invokes the recovery hook once after closing the connection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goldy-recovery-hook-'));
  const file = path.join(directory, 'database.sqlite');
  let calls = 0;
  const originalCheck = IntegrityCheckService.check;
  const originalHook = global.onDatabaseCorruption;
  try {
    IntegrityCheckService.check = () => ({
      status: HealthState.FAILED,
      errors: ['Simulated integrity failure'],
    });
    global.onDatabaseCorruption = () => {
      calls += 1;
      return { status: RecoveryStatus.FAILED, errors: ['Recovery unavailable'] };
    };
    assert.throws(
      () => createDatabase(file),
      (error) => error.code === 'DATABASE_RECOVERY_FAILED',
    );
    assert.equal(calls, 1);
  } finally {
    IntegrityCheckService.check = originalCheck;
    if (originalHook === undefined) delete global.onDatabaseCorruption;
    else global.onDatabaseCorruption = originalHook;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('automatic recovery uses only the active identity and includes backup WAL frames', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goldy-recovery-isolation-'));
  const active = path.join(directory, 'data', 'production.sqlite');
  fs.mkdirSync(path.dirname(active));
  const db = new Database(active);
  db.exec('CREATE TABLE records (id INTEGER); INSERT INTO records VALUES (1)');
  const service = new StartupBackupService(db);
  const backup = service.createBackup();
  db.close();
  const source = new Database(backup);
  try {
    source.pragma('journal_mode = WAL');
    source.pragma('wal_autocheckpoint = 0');
    source.pragma('wal_checkpoint(TRUNCATE)');
    source.exec('INSERT INTO records VALUES (2)');
    fs.writeFileSync(active, 'damaged database retained for forensic recovery');
    const shared = path.join(directory, 'backups', 'newest-demo.db');
    const demo = new Database(shared);
    demo.exec('CREATE TABLE records (id INTEGER); INSERT INTO records VALUES (99)');
    demo.close();
    const recovered = CorruptionRecoveryService.recover(active);
    assert.equal(recovered.status, RecoveryStatus.SUCCESS);
    const restored = new Database(active, { readonly: true });
    assert.deepEqual(restored.prepare('SELECT id FROM records ORDER BY id').all(), [
      { id: 1 },
      { id: 2 },
    ]);
    restored.close();
    assert.equal(
      fs.readFileSync(path.join(path.dirname(active), recovered.corruptedFilename), 'utf8'),
      'damaged database retained for forensic recovery',
    );
  } finally {
    source.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup refuses to create a blank database after an interrupted restore', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goldy-interrupted-restore-'));
  const active = path.join(directory, 'workshop.sqlite');
  const rollback = `${active}.preserved.rollback`;
  let unexpected;
  try {
    fs.writeFileSync(path.join(directory, 'restore.lock'), 'interrupted restore');
    fs.writeFileSync(rollback, 'preserved original');
    assert.throws(
      () => {
        unexpected = createDatabase(active);
      },
      (error) => error.code === 'DATABASE_MAINTENANCE_PENDING',
    );
    assert.equal(fs.existsSync(active), false);
    assert.equal(fs.readFileSync(rollback, 'utf8'), 'preserved original');
  } finally {
    unexpected?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
