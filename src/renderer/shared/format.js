// Money as shown across the screens, Indian style.
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** ₹1,23,456.50 */
export const rupees = (value) => inr.format(Number(value || 0));

/** ₹1,23,457 (Home screen totals) */
export const rupeesWhole = (value) => inrWhole.format(Number(value || 0));

/** ₹123456.50, as printed on bills and in tables */
export const money = (value) => `₹${Number(value || 0).toFixed(2)}`;
