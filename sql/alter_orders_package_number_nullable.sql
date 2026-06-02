-- Allow platform-origin orders to exist before ERP package data is available.
ALTER TABLE orders
  MODIFY COLUMN package_number VARCHAR(100) NULL DEFAULT NULL COMMENT '包裹号';
