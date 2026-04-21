CREATE TABLE IF NOT EXISTS `back_list` (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  `order_id` varchar(100) NOT NULL COMMENT '原始订单号',
  `package_number` varchar(100) NOT NULL COMMENT '包裹号',
  `buyer_name` varchar(200) DEFAULT NULL COMMENT '买家姓名',
  `contact_name` varchar(200) DEFAULT NULL COMMENT '联系人姓名',
  `buyer_account` varchar(200) DEFAULT NULL COMMENT '买家账号',
  `buyer_country` varchar(10) DEFAULT NULL COMMENT '买家国家代码',
  `device_fingerprint` varchar(255) DEFAULT NULL COMMENT '设备指纹',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_package` (`order_id`,`package_number`),
  KEY `idx_order_id` (`order_id`),
  KEY `idx_package_number` (`package_number`),
  KEY `idx_device_fingerprint` (`device_fingerprint`)
);

CREATE TABLE IF NOT EXISTS `order_address` (
  `addr_id` int NOT NULL AUTO_INCREMENT COMMENT '地址自增主键',
  `source_id` varchar(50) DEFAULT NULL,
  `order_id` varchar(100) NOT NULL COMMENT '关联订单号',
  `phone_number` varchar(50) DEFAULT NULL,
  `country` varchar(10) DEFAULT NULL,
  `province` varchar(100) DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `district` varchar(100) DEFAULT NULL,
  `contact_person` varchar(200) DEFAULT NULL,
  `mobile` varchar(50) DEFAULT NULL,
  `detail_address` text,
  `address2` varchar(200) DEFAULT NULL,
  `email` varchar(200) DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`addr_id`),
  UNIQUE KEY `uk_order_id` (`order_id`),
  KEY `idx_phone` (`phone_number`),
  KEY `idx_email` (`email`)
);
