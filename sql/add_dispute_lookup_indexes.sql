-- Indexes for dispute-user lookup:
-- order_address.email -> orders.transaction_id -> paypal_disputes.seller_transaction_id

SET @has_orders_tx_idx := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'orders'
    AND column_name = 'transaction_id'
);
SET @sql := IF(
  @has_orders_tx_idx > 0,
  'SELECT ''orders.transaction_id already indexed'' AS message',
  'CREATE INDEX idx_orders_transaction_id ON orders(transaction_id)'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_dispute_seller_tx_idx := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'paypal_disputes'
    AND column_name = 'seller_transaction_id'
);
SET @sql := IF(
  @has_dispute_seller_tx_idx > 0,
  'SELECT ''paypal_disputes.seller_transaction_id already indexed'' AS message',
  'CREATE INDEX idx_paypal_disputes_seller_tx ON paypal_disputes(seller_transaction_id)'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
