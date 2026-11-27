// Business dates follow the laptop's calendar; audit timestamps remain UTC.
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Adds whole months to a YYYY-MM-DD date (or the date part of a timestamp),
 * staying on the last day of a shorter month: 31 Jan + 1 month = 28/29 Feb.
 */
export function addMonths(dateText, months) {
  const [year, month, day] = String(dateText).slice(0, 10).split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + Number(months), 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** First day of the month of a YYYY-MM-DD date. */
export const monthStart = (dateText) => `${String(dateText).slice(0, 7)}-01`;

/** The laptop's calendar date of a SQLite UTC timestamp ('YYYY-MM-DD HH:MM:SS'). */
export function localDateOf(timestamp) {
  const text = String(timestamp);
  if (text.length <= 10) return text;
  return localDate(
    new Date(`${text.replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? '' : 'Z'}`),
  );
}
