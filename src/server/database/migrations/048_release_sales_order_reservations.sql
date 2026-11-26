-- The Sales Orders screen was removed (it could reserve stock but never bill,
-- deliver or cancel an order). Release any stock it still holds so job cards
-- and counter sales can use it, and mark those open orders cancelled.
UPDATE inventory_reservations
SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
WHERE reference_table = 'sales_orders' AND status = 'ACTIVE';

UPDATE sales_orders
SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
WHERE status IN ('DRAFT', 'CONFIRMED');
