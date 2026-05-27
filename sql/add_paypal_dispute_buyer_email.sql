-- Add and backfill paypal_disputes.buyer_email from detail_payload.

SET @has_buyer_email_column := (
  SELECT COUNT(1)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'paypal_disputes'
    AND column_name = 'buyer_email'
);
SET @sql := IF(
  @has_buyer_email_column > 0,
  'SELECT ''paypal_disputes.buyer_email already exists'' AS message',
  'ALTER TABLE paypal_disputes ADD COLUMN buyer_email VARCHAR(256) DEFAULT NULL COMMENT ''PayPal 争议买家邮箱'' AFTER buyer_payer_id'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_buyer_email_idx := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'paypal_disputes'
    AND index_name = 'idx_buyer_email'
);
SET @sql := IF(
  @has_buyer_email_idx > 0,
  'SELECT ''paypal_disputes.buyer_email already indexed'' AS message',
  'CREATE INDEX idx_buyer_email ON paypal_disputes(buyer_email)'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE paypal_disputes
SET buyer_email = LOWER(TRIM(NULLIF(COALESCE(
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.buyer.email')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.buyer.email_address')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.buyer_info.email')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.buyer_info.email_address')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.payer.email')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.payer.email_address')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.disputed_transactions[0].buyer.email')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.disputed_transactions[0].buyer.email_address')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.disputed_transactions[0].buyer_info.email')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.disputed_transactions[0].buyer_info.email_address')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.disputed_transactions[0].transaction_info.buyer.email')), 'null'), ''),
  NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(detail_payload, '$.disputed_transactions[0].transaction_info.buyer.email_address')), 'null'), '')
), '')))
WHERE detail_payload IS NOT NULL
  AND detail_payload <> ''
  AND JSON_VALID(detail_payload)
  AND (buyer_email IS NULL OR buyer_email = '');
