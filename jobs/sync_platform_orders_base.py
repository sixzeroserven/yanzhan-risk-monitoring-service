"""
Sync base orders from Shoplazza / Shopline into existing tables.

This script is intentionally independent from the older sync scripts. It reuses
their API clients and field extraction helpers, but does not modify them.

Scope:
  - writes orders + order_address base fields
  - does not update black_state, package_number, transaction_id, or device_fingerprint
  - inserts new orders with package_number = NULL
  - maps unpaid orders to order_state = "ordered"
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import pymysql
import requests
from dotenv import load_dotenv

import sync_shoplazza_order_fields as shoplazza
import sync_shopline_order_fields as shopline

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

MYSQL_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", ""),
    "charset": "utf8mb4",
}

ORDER_COLUMNS: Tuple[Tuple[str, str, str], ...] = (
    ("transaction_id", "VARCHAR(100) DEFAULT NULL COMMENT '交易号'", "order_id"),
    ("client_ip", "VARCHAR(45) DEFAULT NULL COMMENT '客户端 IP'", "transaction_id"),
    ("order_created_time", "DATETIME DEFAULT NULL COMMENT '订单创建时间'", "client_ip"),
    ("last_landing_url", "TEXT DEFAULT NULL COMMENT '末次落地页 URL'", "order_created_time"),
    ("device", "VARCHAR(512) DEFAULT NULL COMMENT '设备/UA 等'", "last_landing_url"),
    ("payment_method", "VARCHAR(100) DEFAULT NULL COMMENT '支付方式'", "device"),
    ("payment_channel", "VARCHAR(100) DEFAULT NULL COMMENT '支付渠道'", "payment_method"),
    ("variant_id", "VARCHAR(255) DEFAULT NULL COMMENT 'SKU/变体 ID（多行商品取首行）'", "payment_channel"),
    ("logistics_tracking_number", "VARCHAR(255) DEFAULT NULL COMMENT '物流单号'", "variant_id"),
    ("logistics_carrier_name", "VARCHAR(200) DEFAULT NULL COMMENT '物流商名称'", "logistics_tracking_number"),
    ("logistics_created_time", "DATETIME DEFAULT NULL COMMENT '物流/履约创建时间'", "logistics_carrier_name"),
    ("buyer_name", "VARCHAR(200) DEFAULT NULL COMMENT '买家姓名'", "package_number"),
    ("contact_name", "VARCHAR(200) DEFAULT NULL COMMENT '联系人姓名'", "buyer_name"),
    ("buyer_account", "VARCHAR(200) DEFAULT NULL COMMENT '买家账号'", "contact_name"),
    ("buyer_country", "VARCHAR(10) DEFAULT NULL COMMENT '买家国家代码'", "buyer_account"),
    ("black_state", "TINYINT(1) NOT NULL DEFAULT 0 COMMENT '黑名单状态'", "buyer_country"),
    ("order_state", "VARCHAR(64) DEFAULT NULL COMMENT '订单状态'", "black_state"),
)

ORDER_UPDATE_COLUMNS = (
    "client_ip",
    "order_created_time",
    "last_landing_url",
    "device",
    "payment_method",
    "payment_channel",
    "variant_id",
    "logistics_tracking_number",
    "logistics_carrier_name",
    "logistics_created_time",
    "buyer_name",
    "contact_name",
    "buyer_account",
    "buyer_country",
    "order_state",
)

ADDRESS_COLUMNS = (
    "source_id",
    "phone_number",
    "country",
    "province",
    "city",
    "district",
    "contact_person",
    "mobile",
    "detail_address",
    "address2",
    "email",
)

UNPAID_VALUES = {
    "unpaid",
    "not_paid",
    "not paid",
    "pending",
    "payment_pending",
    "pending_payment",
    "awaiting_payment",
    "awaiting payment",
    "authorized",
    "authorization",
    "unsettled",
}

NO_PAYMENT_VALUES = {
    "none",
    "no_payment",
    "no payment",
    "manual",
}

TEST_ORDER_NAMES = {
    "test 1",
    "test test",
    "test1 test1",
    "test1234 test1234",
    "test22 test22",
    "ldy ldy",
    "test",
    "test 123",
    "uuu test",
}


def truthy_env(name: str) -> bool:
    return (os.getenv(name) or "").strip().lower() in ("1", "true", "yes", "y")


def normalize_test_name(value: Optional[str]) -> str:
    return " ".join(str(value or "").strip().lower().split())


def test_order_reason(row: Dict[str, Any]) -> Optional[str]:
    for field in ("buyer_name", "contact_name"):
        normalized = normalize_test_name(row.get(field))
        if normalized in TEST_ORDER_NAMES:
            return f"{field}={normalized}"
    return None


def parse_datetime_arg(value: Optional[str], end_of_day: bool = False) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        base = datetime.fromisoformat(text)
        return base.replace(hour=23, minute=59, second=59, microsecond=999999) if end_of_day else base
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def connect_db():
    return pymysql.connect(**MYSQL_CONFIG)


def table_exists(cursor, table_name: str) -> bool:
    cursor.execute(
        """
        SELECT COUNT(1) FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = %s
        """,
        (table_name,),
    )
    return bool(cursor.fetchone()[0])


def column_exists(cursor, table_name: str, column_name: str) -> bool:
    cursor.execute(
        """
        SELECT COUNT(1) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = %s AND column_name = %s
        """,
        (table_name, column_name),
    )
    return bool(cursor.fetchone()[0])


def ensure_tables(cursor) -> None:
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS orders (
            id INT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
            order_id VARCHAR(100) NOT NULL COMMENT '原始订单号',
            transaction_id VARCHAR(100) DEFAULT NULL COMMENT '交易号',
            client_ip VARCHAR(45) DEFAULT NULL COMMENT '客户端 IP',
            order_created_time DATETIME DEFAULT NULL COMMENT '订单创建时间',
            last_landing_url TEXT DEFAULT NULL COMMENT '末次落地页 URL',
            device VARCHAR(512) DEFAULT NULL COMMENT '设备/UA 等',
            payment_method VARCHAR(100) DEFAULT NULL COMMENT '支付方式',
            payment_channel VARCHAR(100) DEFAULT NULL COMMENT '支付渠道',
            variant_id VARCHAR(255) DEFAULT NULL COMMENT 'SKU/变体 ID（多行商品取首行）',
            logistics_tracking_number VARCHAR(255) DEFAULT NULL COMMENT '物流单号',
            logistics_carrier_name VARCHAR(200) DEFAULT NULL COMMENT '物流商名称',
            logistics_created_time DATETIME DEFAULT NULL COMMENT '物流/履约创建时间',
            package_number VARCHAR(100) DEFAULT NULL COMMENT '包裹号',
            buyer_name VARCHAR(200) DEFAULT NULL COMMENT '买家姓名',
            contact_name VARCHAR(200) DEFAULT NULL COMMENT '联系人姓名',
            buyer_account VARCHAR(200) DEFAULT NULL COMMENT '买家账号',
            buyer_country VARCHAR(10) DEFAULT NULL COMMENT '买家国家代码',
            black_state TINYINT(1) NOT NULL DEFAULT 0 COMMENT '黑名单状态',
            order_state VARCHAR(64) DEFAULT NULL COMMENT '订单状态',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_order_package (order_id, package_number),
            KEY idx_order_id (order_id),
            KEY idx_orders_transaction_id (transaction_id),
            KEY idx_package_number (package_number)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS order_address (
            addr_id INT AUTO_INCREMENT PRIMARY KEY COMMENT '地址自增主键',
            source_id VARCHAR(50) DEFAULT NULL,
            order_id VARCHAR(100) NOT NULL COMMENT '关联订单号',
            phone_number VARCHAR(50) DEFAULT NULL,
            country VARCHAR(10) DEFAULT NULL,
            province VARCHAR(100) DEFAULT NULL,
            city VARCHAR(100) DEFAULT NULL,
            district VARCHAR(100) DEFAULT NULL,
            contact_person VARCHAR(200) DEFAULT NULL,
            mobile VARCHAR(50) DEFAULT NULL,
            detail_address TEXT,
            address2 VARCHAR(255) DEFAULT NULL,
            email VARCHAR(200) DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_order_id (order_id),
            KEY idx_phone (phone_number),
            KEY idx_email (email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        """
    )


def ensure_order_columns(cursor) -> None:
    for column, ddl, after in ORDER_COLUMNS:
        if column_exists(cursor, "orders", column):
            continue
        after_clause = f" AFTER `{after}`" if column_exists(cursor, "orders", after) else ""
        cursor.execute(f"ALTER TABLE orders ADD COLUMN `{column}` {ddl}{after_clause}")
        logger.info("Added orders.%s", column)


def ensure_package_number_nullable(cursor) -> None:
    if not table_exists(cursor, "orders") or not column_exists(cursor, "orders", "package_number"):
        return
    cursor.execute(
        """
        SELECT IS_NULLABLE FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'package_number'
        """
    )
    row = cursor.fetchone()
    if row and str(row[0]).upper() == "NO":
        cursor.execute(
            "ALTER TABLE orders MODIFY COLUMN package_number VARCHAR(100) NULL DEFAULT NULL COMMENT '包裹号'"
        )
        logger.info("Changed orders.package_number to nullable")


def ensure_schema() -> None:
    conn = connect_db()
    try:
        with conn.cursor() as cursor:
            ensure_tables(cursor)
            ensure_order_columns(cursor)
            ensure_package_number_nullable(cursor)
        conn.commit()
    finally:
        conn.close()


def as_obj(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def dig(value: Any, *keys: str) -> Any:
    cur = value
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def first_str(*values: Any, max_len: Optional[int] = None) -> Optional[str]:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text[:max_len] if max_len is not None else text
    return None


def first_nested_str(*values: Any, max_len: Optional[int] = None) -> Optional[str]:
    for value in values:
        if value is None:
            continue
        if isinstance(value, list):
            hit = first_nested_str(*value, max_len=max_len)
            if hit:
                return hit
            continue
        if isinstance(value, dict):
            continue
        text = str(value).strip()
        if text:
            return text[:max_len] if max_len is not None else text
    return None


def case_pick(record: Dict[str, Any], *keys: str) -> Any:
    if not record:
        return None
    wanted = {key.lower() for key in keys}
    for key, value in record.items():
        if str(key).lower() in wanted:
            return value
    return None


def first_field(record: Dict[str, Any], keys: Tuple[str, ...], max_len: Optional[int] = None) -> Optional[str]:
    return first_nested_str(*(case_pick(record, key) for key in keys), max_len=max_len)


def join_name(first: Any, last: Any) -> Optional[str]:
    text = " ".join(x for x in (first_str(first), first_str(last)) if x)
    return text or None


def normalize_hash_order_number(value: Any) -> Optional[str]:
    text = first_str(value)
    if not text:
        return None
    if text.startswith("#"):
        stripped = text[1:].strip()
        return stripped or text
    return text


def choose_address(order: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    shipping = {}
    for key in ("shipping_address", "shippingAddress", "shipping_addr", "delivery_address"):
        shipping = as_obj(order.get(key))
        if shipping:
            break
    billing = {}
    for key in ("billing_address", "billingAddress"):
        billing = as_obj(order.get(key))
        if billing:
            break
    return shipping, billing


def pick_order_id(platform: str, order: Dict[str, Any], store: Dict[str, str]) -> Optional[str]:
    # Use the platform's stable internal order id for DB order_id. Display order
    # numbers like Shoplazza number / Shopline name are only fallbacks.
    if platform == "shopline":
        display = first_str(order.get("name"), order.get("order_name"), order.get("orderName"))
        return first_str(
            order.get("id"),
            order.get("order_id"),
            order.get("orderId"),
            order.get("admin_graphql_api_id"),
            normalize_hash_order_number(order.get("order_number")),
            normalize_hash_order_number(order.get("orderNo")),
            normalize_hash_order_number(order.get("order_no")),
            normalize_hash_order_number(order.get("number")),
            normalize_hash_order_number(display),
            max_len=100,
        )

    return first_str(
        order.get("id"),
        order.get("order_id"),
        order.get("orderId"),
        normalize_hash_order_number(order.get("order_number")),
        normalize_hash_order_number(order.get("orderNumber")),
        normalize_hash_order_number(order.get("name")),
        normalize_hash_order_number(order.get("number")),
        max_len=100,
    )


def pick_detail_id(order: Dict[str, Any], fallback_order_id: str) -> str:
    return first_str(
        order.get("id"),
        order.get("order_id"),
        order.get("orderId"),
        order.get("order_number"),
        order.get("name"),
        fallback_order_id,
    ) or fallback_order_id


def is_unpaid(order: Dict[str, Any]) -> bool:
    bool_candidates = (
        order.get("paid"),
        order.get("is_paid"),
        order.get("isPaid"),
        order.get("payment_paid"),
    )
    for value in bool_candidates:
        if isinstance(value, bool) and value is False:
            return True
        if isinstance(value, (int, float)) and value == 0:
            return True

    for key in (
        "financial_status",
        "financialStatus",
        "payment_status",
        "paymentStatus",
        "pay_status",
        "payStatus",
        "payment_state",
        "paymentState",
    ):
        text = first_str(order.get(key))
        if text and text.strip().lower() in UNPAID_VALUES:
            return True

    payment_method = first_str(order.get("payment_method"), order.get("paymentMethod"))
    if payment_method and payment_method.strip().lower() in NO_PAYMENT_VALUES:
        return True

    transactions = order.get("transactions")
    if isinstance(transactions, list):
        for item in transactions:
            status = first_str(dig(item, "status"), dig(item, "payment_status"))
            if status and status.lower() in UNPAID_VALUES:
                return True
    return False


def extract_order_state(order: Dict[str, Any]) -> Optional[str]:
    if is_unpaid(order):
        return "ordered"
    state = first_str(
        order.get("order_state"),
        order.get("orderState"),
        order.get("status"),
        order.get("order_status"),
        order.get("orderStatus"),
        order.get("fulfillment_status"),
        order.get("fulfillmentStatus"),
        order.get("financial_status"),
        order.get("financialStatus"),
        max_len=64,
    )
    if state and state.lower() in UNPAID_VALUES:
        return "ordered"
    return state


def extract_customer_fields(order: Dict[str, Any]) -> Dict[str, Optional[str]]:
    customer = as_obj(order.get("customer"))
    shipping, billing = choose_address(order)
    email = first_str(
        order.get("email"),
        order.get("contact_email"),
        order.get("customer_email"),
        order.get("buyer_email"),
        customer.get("email"),
        customer.get("contact_email"),
        shipping.get("email"),
        billing.get("email"),
        max_len=200,
    )
    buyer_name = first_str(
        customer.get("name"),
        join_name(customer.get("first_name"), customer.get("last_name")),
        order.get("customer_name"),
        order.get("buyer_name"),
        shipping.get("name"),
        shipping.get("contact_person"),
        shipping.get("contactPerson"),
        shipping.get("full_name"),
        billing.get("name"),
        max_len=200,
    )
    contact_name = first_str(
        shipping.get("name"),
        shipping.get("contact_person"),
        shipping.get("contactPerson"),
        shipping.get("full_name"),
        billing.get("name"),
        customer.get("name"),
        buyer_name,
        max_len=200,
    )
    buyer_country = first_str(
        shipping.get("country_code"),
        shipping.get("countryCode"),
        shipping.get("country"),
        billing.get("country_code"),
        billing.get("countryCode"),
        billing.get("country"),
        max_len=10,
    )
    return {
        "buyer_name": buyer_name,
        "contact_name": contact_name,
        "buyer_account": email,
        "buyer_country": buyer_country,
    }


def extract_address_row(order_id: str, order: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    customer = as_obj(order.get("customer"))
    shipping, billing = choose_address(order)
    addr = shipping or billing
    email = first_str(
        order.get("email"),
        order.get("contact_email"),
        order.get("customer_email"),
        order.get("buyer_email"),
        customer.get("email"),
        customer.get("contact_email"),
        shipping.get("email"),
        billing.get("email"),
        max_len=200,
    )
    phone = first_str(
        order.get("phone"),
        order.get("phone_number"),
        order.get("mobile"),
        addr.get("phone"),
        addr.get("phone_number"),
        addr.get("mobile"),
        addr.get("tel"),
        customer.get("phone"),
        customer.get("mobile"),
        max_len=50,
    )
    contact_person = first_str(
        addr.get("name"),
        addr.get("contact_person"),
        addr.get("contactPerson"),
        addr.get("full_name"),
        customer.get("name"),
        join_name(customer.get("first_name"), customer.get("last_name")),
        max_len=200,
    )
    row = {
        "source_id": first_str(order.get("id"), order.get("source_id"), order.get("sourceId"), max_len=50),
        "order_id": order_id,
        "phone_number": phone,
        "country": first_str(addr.get("country_code"), addr.get("countryCode"), addr.get("country"), max_len=10),
        "province": first_str(
            addr.get("province"),
            addr.get("province_code"),
            addr.get("provinceCode"),
            addr.get("state"),
            max_len=100,
        ),
        "city": first_str(addr.get("city"), max_len=100),
        "district": first_str(addr.get("district"), max_len=100),
        "contact_person": contact_person,
        "mobile": phone,
        "detail_address": first_str(
            addr.get("address1"),
            addr.get("address"),
            addr.get("detail_address"),
            addr.get("detailAddress"),
        ),
        "address2": first_str(addr.get("address2"), addr.get("address_2"), addr.get("apartment"), max_len=255),
        "email": email,
    }
    if any(row.get(col) for col in ADDRESS_COLUMNS):
        return row
    return None


def iter_payment_objects(order: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for key in ("payment_line", "paymentLine", "payment_details", "paymentDetails"):
        value = order.get(key)
        if isinstance(value, dict):
            out.append(value)
        elif isinstance(value, list):
            out.extend(item for item in value if isinstance(item, dict))
    transactions = order.get("transactions")
    if isinstance(transactions, list):
        out.extend(item for item in transactions if isinstance(item, dict))
    return out


def first_payment_object_value(order: Dict[str, Any], *keys: str) -> Optional[str]:
    for item in iter_payment_objects(order):
        values = [item.get(key) for key in keys]
        values.extend(dig(item, "gateway", key) for key in keys)
        values.extend(dig(item, "payment_gateway", key) for key in keys)
        hit = first_str(*values)
        if hit:
            return hit
    return None


def extract_payment_overrides(order: Dict[str, Any]) -> Dict[str, Optional[str]]:
    method = first_str(
        order.get("payment_method"),
        order.get("paymentMethod"),
        first_payment_object_value(order, "payment_method", "paymentMethod", "method", "name", "type"),
        max_len=100,
    )
    channel = first_str(
        order.get("payment_channel"),
        order.get("paymentChannel"),
        order.get("payment_gateway_name"),
        first_payment_object_value(
            order,
            "payment_channel",
            "paymentChannel",
            "payment_gateway_name",
            "gateway",
            "gateway_name",
            "channel",
            "name",
        ),
        max_len=100,
    )
    pgn = order.get("payment_gateway_names")
    if not channel and isinstance(pgn, list):
        joined = ",".join(str(x).strip() for x in pgn if x is not None and str(x).strip())
        channel = joined[:100] if joined else None
    return {"payment_method": method, "payment_channel": channel}


LOGISTICS_CONTAINER_KEYS = (
    "fulfillment",
    "fulfillments",
    "shipment",
    "shipments",
    "shipping",
    "shipping_line",
    "shippingLine",
    "shipping_lines",
    "shippingLines",
    "logistics",
    "logistic",
    "logistics_info",
    "logisticsInfo",
    "delivery",
    "deliveries",
    "delivery_info",
    "deliveryInfo",
    "package",
    "packages",
    "tracking",
    "tracking_info",
    "trackingInfo",
)

TRACKING_NUMBER_KEYS = (
    "tracking_number",
    "trackingNumber",
    "tracking_no",
    "trackingNo",
    "tracking_code",
    "trackingCode",
    "tracking_numbers",
    "trackingNumbers",
    "waybill_number",
    "waybillNumber",
    "waybill_no",
    "waybillNo",
    "logistics_no",
    "logisticsNo",
    "logistics_number",
    "logisticsNumber",
    "express_no",
    "expressNo",
    "track_number",
    "trackNumber",
)

CARRIER_NAME_KEYS = (
    "tracking_company",
    "trackingCompany",
    "tracking_company_name",
    "trackingCompanyName",
    "carrier",
    "carrier_name",
    "carrierName",
    "logistics_company",
    "logisticsCompany",
    "logistics_company_name",
    "logisticsCompanyName",
    "shipping_company",
    "shippingCompany",
)

LOGISTICS_TIME_KEYS = (
    "logistics_created_time",
    "logisticsCreatedTime",
    "shipment_created_at",
    "shipmentCreatedAt",
    "fulfillment_created_at",
    "fulfillmentCreatedAt",
    "created_at",
    "createdAt",
    "create_time",
    "createTime",
    "created_time",
    "createdTime",
    "fulfilled_at",
    "fulfilledAt",
    "shipped_at",
    "shippedAt",
    "updated_at",
    "updatedAt",
    "update_time",
    "updateTime",
)


def parse_optional_datetime(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    text = first_nested_str(value)
    if not text:
        return None
    normalized = text.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(normalized)
        return dt.replace(tzinfo=None) if dt.tzinfo else dt
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(normalized, fmt)
        except ValueError:
            continue
    return None


def iter_logistics_objects(order: Dict[str, Any]) -> List[Dict[str, Any]]:
    seen = set()
    out: List[Dict[str, Any]] = []

    def add(value: Any, depth: int = 0) -> None:
        if depth > 4 or value is None:
            return
        if isinstance(value, list):
            for item in value:
                add(item, depth)
            return
        if not isinstance(value, dict):
            return
        marker = id(value)
        if marker in seen:
            return
        seen.add(marker)
        out.append(value)
        for key in LOGISTICS_CONTAINER_KEYS:
            nested = case_pick(value, key)
            if nested is not None:
                add(nested, depth + 1)

    # Fulfillment/shipment-like containers have the best logistics data. Use
    # order-level fields only after those candidates.
    for key in LOGISTICS_CONTAINER_KEYS:
        nested = case_pick(order, key)
        if nested is not None:
            add(nested)
    add(order)
    return out


def extract_logistics_fields(order: Dict[str, Any]) -> Dict[str, Optional[Any]]:
    tracking_number: Optional[str] = None
    carrier_name: Optional[str] = None
    created_time: Optional[datetime] = None

    for item in iter_logistics_objects(order):
        if not tracking_number:
            tracking_number = first_field(item, TRACKING_NUMBER_KEYS, max_len=255)
        if not carrier_name:
            carrier_name = first_field(item, CARRIER_NAME_KEYS, max_len=200)
        if not created_time:
            time_keys = LOGISTICS_TIME_KEYS
            if item is order:
                time_keys = (
                    "logistics_created_time",
                    "logisticsCreatedTime",
                    "shipment_created_at",
                    "shipmentCreatedAt",
                    "fulfillment_created_at",
                    "fulfillmentCreatedAt",
                    "shipped_at",
                    "shippedAt",
                )
            for key in time_keys:
                created_time = parse_optional_datetime(case_pick(item, key))
                if created_time:
                    break
        if tracking_number and carrier_name and created_time:
            break

    return {
        "logistics_tracking_number": tracking_number,
        "logistics_carrier_name": carrier_name,
        "logistics_created_time": created_time,
    }


def extract_base_order_row(platform: str, store: Dict[str, str], order: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    order_id = pick_order_id(platform, order, store)
    if not order_id:
        return None
    sync_row = shopline.extract_sync_row(order) if platform == "shopline" else shoplazza.extract_sync_row(order)
    row: Dict[str, Any] = {
        "order_id": order_id,
        "client_ip": sync_row.get("client_ip"),
        "order_created_time": sync_row.get("order_created_time"),
        "last_landing_url": sync_row.get("last_landing_url"),
        "device": sync_row.get("device"),
        "payment_method": sync_row.get("payment_method"),
        "payment_channel": sync_row.get("payment_channel"),
        "variant_id": sync_row.get("variant_id"),
        "order_state": extract_order_state(order),
    }
    payment_overrides = extract_payment_overrides(order)
    for key, value in payment_overrides.items():
        if value and not row.get(key):
            row[key] = value
    row.update(extract_logistics_fields(order))
    row.update(extract_customer_fields(order))
    return row


def order_time_status(args, row: Optional[Dict[str, Any]]) -> str:
    if not getattr(args, "start_dt", None) and not getattr(args, "end_dt", None):
        return "in_range"
    if not row:
        return "unknown"
    dt = row.get("order_created_time")
    if isinstance(dt, str):
        dt = parse_datetime_arg(dt)
    if not isinstance(dt, datetime):
        return "unknown"
    if args.start_dt and dt < args.start_dt:
        return "before_start"
    if args.end_dt and dt > args.end_dt:
        return "after_end"
    return "in_range"


def should_stop_after_page(args, page_statuses: List[str]) -> bool:
    if not getattr(args, "start_dt", None) or not page_statuses:
        return False
    return all(status == "before_start" for status in page_statuses)


def nonempty_update_items(row: Dict[str, Any], columns: Tuple[str, ...]) -> List[Tuple[str, Any]]:
    out: List[Tuple[str, Any]] = []
    for col in columns:
        value = row.get(col)
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        out.append((col, value))
    return out


def upsert_order(cursor, row: Dict[str, Any], dry_run: bool) -> str:
    order_id = row["order_id"]
    cursor.execute("SELECT COUNT(1) FROM orders WHERE BINARY order_id = BINARY %s", (order_id,))
    exists = bool(cursor.fetchone()[0])
    items = nonempty_update_items(row, ORDER_UPDATE_COLUMNS)

    if dry_run:
        return "would_update" if exists else "would_insert"

    if exists:
        if not items:
            return "matched_no_values"
        sets = ", ".join(f"`{col}` = %s" for col, _ in items)
        values = [value for _, value in items]
        values.append(order_id)
        cursor.execute(f"UPDATE orders SET {sets} WHERE BINARY order_id = BINARY %s", values)
        return "updated"

    insert_cols = ["order_id", "package_number", "black_state"]
    insert_vals: List[Any] = [order_id, None, 0]
    for col, value in items:
        insert_cols.append(col)
        insert_vals.append(value)
    placeholders = ", ".join(["%s"] * len(insert_cols))
    quoted_cols = ", ".join(f"`{col}`" for col in insert_cols)
    cursor.execute(f"INSERT INTO orders ({quoted_cols}) VALUES ({placeholders})", insert_vals)
    return "inserted"


def upsert_address(cursor, row: Optional[Dict[str, Any]], dry_run: bool) -> str:
    if not row:
        return "skipped_no_address"
    update_items = nonempty_update_items(row, ADDRESS_COLUMNS)
    if dry_run:
        return "would_upsert"
    insert_cols = ["order_id", *ADDRESS_COLUMNS]
    insert_vals = [row.get(col) for col in insert_cols]
    update_sets = ", ".join(f"`{col}` = VALUES(`{col}`)" for col, _ in update_items)
    placeholders = ", ".join(["%s"] * len(insert_cols))
    quoted_cols = ", ".join(f"`{col}`" for col in insert_cols)
    if update_sets:
        sql = (
            f"INSERT INTO order_address ({quoted_cols}) VALUES ({placeholders}) "
            f"ON DUPLICATE KEY UPDATE {update_sets}"
        )
    else:
        sql = (
            f"INSERT INTO order_address ({quoted_cols}) VALUES ({placeholders}) "
            "ON DUPLICATE KEY UPDATE order_id = order_id"
        )
    cursor.execute(sql, insert_vals)
    return "upserted"


def add_stat(stats: Dict[str, int], key: str, value: int = 1) -> None:
    stats[key] = stats.get(key, 0) + value


def format_debug(platform: str, store: Dict[str, str], raw: Dict[str, Any], base: Dict[str, Any], row: Dict[str, Any]) -> str:
    payload = {
        "platform": platform,
        "store": store.get("storeDomain"),
        "raw_keys_sample": sorted(str(k) for k in raw.keys())[:80],
        "normalized_keys_sample": sorted(str(k) for k in base.keys())[:80],
        "order_row": {k: str(v) if isinstance(v, datetime) else v for k, v in row.items()},
    }
    return json.dumps(payload, ensure_ascii=False, default=str)


def process_one_order(
    cursor,
    platform: str,
    store: Dict[str, str],
    raw: Dict[str, Any],
    base: Dict[str, Any],
    dry_run: bool,
    debug_fetch: bool,
    debug_budget: List[int],
    stats: Dict[str, int],
) -> None:
    row = extract_base_order_row(platform, store, base)
    if not row:
        add_stat(stats, "skipped_no_order_id")
        return
    reason = test_order_reason(row)
    if reason:
        add_stat(stats, "test_orders_skipped")
        logger.info(
            "skip test order platform=%s store=%s order_id=%s reason=%s",
            platform,
            store.get("storeDomain", "-"),
            row.get("order_id"),
            reason,
        )
        return
    if debug_fetch and debug_budget[0] != 0:
        logger.info("[debug-fetch] %s", format_debug(platform, store, raw, base, row))
        if debug_budget[0] > 0:
            debug_budget[0] -= 1
    order_status = upsert_order(cursor, row, dry_run)
    add_stat(stats, f"orders_{order_status}")
    addr_status = upsert_address(cursor, extract_address_row(row["order_id"], base), dry_run)
    add_stat(stats, f"address_{addr_status}")
    add_stat(stats, "orders_processed")


def maybe_fetch_detail(
    platform: str,
    session: requests.Session,
    store: Dict[str, str],
    base: Dict[str, Any],
    order_id: str,
    verify_tls: bool,
) -> Dict[str, Any]:
    detail_id = pick_detail_id(base, order_id)
    if platform == "shopline":
        ok, detail = shopline.fetch_order_detail(session, store, detail_id, verify_tls)
        return shopline.merge_list_and_detail_order(base, detail) if ok else base
    ok, detail = shoplazza.fetch_order_detail(session, store, detail_id, verify_tls)
    return shoplazza.merge_list_and_detail_order(base, detail) if ok else base


def sync_shoplazza(args, cursor, session: requests.Session, stats: Dict[str, int]) -> None:
    stores = shoplazza.load_stores()
    verify_tls = not truthy_env("SHOPLAZZA_INSECURE_TLS")
    shoplazza.configure_insecure_tls_warnings(verify_tls)
    working_list_path: Dict[str, str] = {}
    debug_budget = [args.debug_fetch_max]
    processed_start = stats.get("orders_processed", 0)

    for store in stores:
        page = 1
        page_token: Optional[str] = None
        pages_this_store = 0
        while True:
            if args.limit is not None and stats.get("orders_processed", 0) - processed_start >= args.limit:
                return
            if args.max_pages_per_store is not None and pages_this_store >= args.max_pages_per_store:
                break
            try:
                orders, next_token, has_more_offset = shoplazza.fetch_orders_list_page(
                    session,
                    store,
                    page,
                    shoplazza.LIST_PAGE_SIZE,
                    page_token,
                    verify_tls,
                    working_list_path,
                )
            except requests.RequestException as e:
                add_stat(stats, "shoplazza_stores_skipped")
                logger.warning("shoplazza store=%s skipped: %s", store.get("storeDomain", "-"), e)
                break
            add_stat(stats, "shoplazza_pages")
            pages_this_store += 1
            add_stat(stats, "shoplazza_orders_scanned", len(orders))
            page_time_statuses: List[str] = []

            for raw in orders:
                base = shoplazza.normalize_list_order_item(raw)
                row = extract_base_order_row("shoplazza", store, base)
                if row and args.fetch_detail:
                    time.sleep(shoplazza.REQUEST_INTERVAL_SEC)
                    base = maybe_fetch_detail("shoplazza", session, store, base, row["order_id"], verify_tls)
                    add_stat(stats, "detail_fetches")
                    row = extract_base_order_row("shoplazza", store, base)
                time_status = order_time_status(args, row)
                page_time_statuses.append(time_status)
                if time_status != "in_range":
                    add_stat(stats, f"filtered_time_{time_status}")
                    continue
                process_one_order(
                    cursor,
                    "shoplazza",
                    store,
                    raw,
                    base,
                    args.dry_run,
                    args.debug_fetch,
                    debug_budget,
                    stats,
                )
                if args.limit is not None and stats.get("orders_processed", 0) - processed_start >= args.limit:
                    return

            logger.info(
                "shoplazza store=%s page=%s list=%s processed=%s time_filtered=%s",
                store["storeDomain"],
                pages_this_store,
                len(orders),
                stats.get("orders_processed", 0),
                sum(1 for status in page_time_statuses if status != "in_range"),
            )
            time.sleep(shoplazza.LIST_INTERVAL_SEC)
            if not orders:
                break
            if should_stop_after_page(args, page_time_statuses):
                logger.info("shoplazza store=%s reached orders older than start date; stop paging", store["storeDomain"])
                break
            if next_token:
                page_token = next_token
                continue
            page_token = None
            if not has_more_offset:
                break
            page += 1


def sync_shopline(args, cursor, session: requests.Session, stats: Dict[str, int]) -> None:
    stores = shopline.load_stores()
    verify_tls = not truthy_env("SHOPLINE_INSECURE_TLS")
    shopline.configure_insecure_tls_warnings(verify_tls)
    debug_budget = [args.debug_fetch_max]
    processed_start = stats.get("orders_processed", 0)

    for store in stores:
        page_token: Optional[str] = None
        pages_this_store = 0
        while True:
            if args.limit is not None and stats.get("orders_processed", 0) - processed_start >= args.limit:
                return
            if args.max_pages_per_store is not None and pages_this_store >= args.max_pages_per_store:
                break
            try:
                orders, next_token = shopline.fetch_orders_list_page(
                    session,
                    store,
                    shopline.LIST_PAGE_SIZE,
                    page_token,
                    verify_tls,
                )
            except requests.RequestException as e:
                add_stat(stats, "shopline_stores_skipped")
                logger.warning("shopline store=%s skipped: %s", store.get("storeDomain", "-"), e)
                break
            add_stat(stats, "shopline_pages")
            pages_this_store += 1
            add_stat(stats, "shopline_orders_scanned", len(orders))
            page_time_statuses: List[str] = []

            for raw in orders:
                base = shopline.normalize_list_order_item(raw)
                row = extract_base_order_row("shopline", store, base)
                if row and args.fetch_detail:
                    time.sleep(shopline.REQUEST_INTERVAL_SEC)
                    base = maybe_fetch_detail("shopline", session, store, base, row["order_id"], verify_tls)
                    add_stat(stats, "detail_fetches")
                    row = extract_base_order_row("shopline", store, base)
                time_status = order_time_status(args, row)
                page_time_statuses.append(time_status)
                if time_status != "in_range":
                    add_stat(stats, f"filtered_time_{time_status}")
                    continue
                process_one_order(
                    cursor,
                    "shopline",
                    store,
                    raw,
                    base,
                    args.dry_run,
                    args.debug_fetch,
                    debug_budget,
                    stats,
                )
                if args.limit is not None and stats.get("orders_processed", 0) - processed_start >= args.limit:
                    return

            logger.info(
                "shopline store=%s page=%s list=%s processed=%s time_filtered=%s",
                store["storeDomain"],
                pages_this_store,
                len(orders),
                stats.get("orders_processed", 0),
                sum(1 for status in page_time_statuses if status != "in_range"),
            )
            time.sleep(shopline.LIST_INTERVAL_SEC)
            if not orders or not next_token:
                break
            if should_stop_after_page(args, page_time_statuses):
                logger.info("shopline store=%s reached orders older than start date; stop paging", store["storeDomain"])
                break
            page_token = next_token


def parse_args():
    parser = argparse.ArgumentParser(
        description="Sync base orders from Shoplazza / Shopline into orders + order_address"
    )
    parser.add_argument("--platform", choices=["shoplazza", "shopline", "all"], default="all")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and normalize, but do not write DB")
    parser.add_argument("--limit", type=int, default=None, help="Max orders to process per selected platform")
    parser.add_argument("--max-pages-per-store", type=int, default=None, help="Debug page limit per store")
    parser.add_argument("--since-days", type=int, default=None, help="Only process orders created in the last N days")
    parser.add_argument("--start-date", default=None, help="Only process orders created at/after this date or datetime")
    parser.add_argument("--end-date", default=None, help="Only process orders created at/before this date or datetime")
    parser.add_argument("--fetch-detail", action="store_true", help="Fetch detail for every listed order")
    parser.add_argument("--debug-fetch", action="store_true", help="Print raw keys and extracted DB row")
    parser.add_argument(
        "--debug-fetch-max",
        type=int,
        default=20,
        help="Max debug rows. Use -1 for unlimited.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.debug_fetch_max < 0:
        args.debug_fetch_max = -1
    args.start_dt = None
    args.end_dt = parse_datetime_arg(args.end_date, end_of_day=True)
    if args.since_days is not None:
        if args.since_days < 0:
            raise ValueError("--since-days must be >= 0")
        args.start_dt = datetime.now() - timedelta(days=args.since_days)
    explicit_start = parse_datetime_arg(args.start_date)
    if explicit_start:
        args.start_dt = max(args.start_dt, explicit_start) if args.start_dt else explicit_start
    if args.start_dt and args.end_dt and args.start_dt > args.end_dt:
        raise ValueError("--start-date / --since-days is later than --end-date")
    if args.start_dt or args.end_dt:
        logger.info("Time filter: start=%s end=%s", args.start_dt or "-", args.end_dt or "-")

    ensure_schema()
    stats: Dict[str, int] = {}
    session = requests.Session()
    conn = connect_db()
    try:
        with conn.cursor() as cursor:
            if args.platform in ("shoplazza", "all"):
                sync_shoplazza(args, cursor, session, stats)
                if not args.dry_run:
                    conn.commit()
            if args.platform in ("shopline", "all"):
                sync_shopline(args, cursor, session, stats)
                if not args.dry_run:
                    conn.commit()
        if args.dry_run:
            conn.rollback()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
        session.close()

    logger.info("Done: %s", json.dumps(stats, ensure_ascii=False, default=str, sort_keys=True))


if __name__ == "__main__":
    main()
