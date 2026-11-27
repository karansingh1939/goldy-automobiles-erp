/** A finite number, or the fallback for empty or non-numeric input. */
export function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Rupees rounded to paise, exactly as every module rounded before it was
 * shared (so stored bills and new ones agree).
 */
export function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}
