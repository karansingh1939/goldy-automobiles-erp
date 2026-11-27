import fs from 'node:fs';
import path from 'node:path';
import { localDate } from './local-date.js';
import { env } from '../../config/env.js';

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/**
 * Writes startup and shutdown messages to the console and to one log file
 * per day (logs/goldy_erp_YYYY-MM-DD.log). A failed write never stops the app.
 */
export class Logger {
  constructor({ logsDir, logLevel } = {}) {
    this.logsDir = logsDir || path.join(env.appDataPath, 'logs');
    const level = String(logLevel || env.logLevel || 'INFO').toUpperCase();
    this.logLevel = level in LEVELS ? level : 'INFO';
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create logs directory at ${this.logsDir}:`, err.message);
    }
  }

  log(level, category, message, context = null) {
    const targetLevel = String(level || 'INFO').toUpperCase();
    if ((LEVELS[targetLevel] ?? 1) < LEVELS[this.logLevel]) return;

    let line = `${new Date().toISOString()} ${targetLevel} ${String(category || 'SYSTEM').toUpperCase()} ${message}`;
    if (context instanceof Error) line += ` | Error: ${context.message} \nStack: ${context.stack}`;
    else if (context) line += ` | Context: ${JSON.stringify(context)}`;

    (targetLevel === 'ERROR' ? console.error : console.log)(line);
    try {
      // Synchronous append keeps lines in order without holding a stream open.
      fs.appendFileSync(
        path.join(this.logsDir, `goldy_erp_${localDate()}.log`),
        `${line}\n`,
        'utf8',
      );
    } catch (err) {
      console.error('Logger append write failed:', err.message);
    }
  }

  debug(category, message, context = null) {
    this.log('DEBUG', category, message, context);
  }

  info(category, message, context = null) {
    this.log('INFO', category, message, context);
  }

  warn(category, message, context = null) {
    this.log('WARN', category, message, context);
  }

  error(category, message, context = null) {
    this.log('ERROR', category, message, context);
  }
}

let defaultLogger = null;

export function getLogger() {
  defaultLogger ||= new Logger();
  return defaultLogger;
}
