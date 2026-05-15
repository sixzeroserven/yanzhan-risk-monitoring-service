"""
同步 PayPal 争议（Disputes）到本地 MySQL。

能力：
1) 使用 PayPal OAuth2 client_credentials 拉取 access_token。
2) 分页请求争议列表（/v1/customer/disputes，使用 create_time_after / create_time_before 过滤）。
3) 默认仅用列表接口分页拉历史争议；可选 --fetch-detail 再逐条请求详情：结构化列仍从详情解析，且将列表项完整 JSON 写入 raw_payload、详情接口完整 JSON 写入 detail_payload。
4) upsert 写入 paypal_disputes 表；--fetch-detail 且 dispute_channel=INTERNAL 时写入 buyer_evidence_notes（evidences[0].notes）。

环境变量（必填）：
- PAYPAL_CLIENT_ID
- PAYPAL_CLIENT_SECRET

环境变量（可选）：
- PAYPAL_BASE_URL=https://api-m.paypal.com
- PAYPAL_DISPUTE_PAGE_SIZE=50
- PAYPAL_DISPUTE_LOOKBACK_DAYS=（不设且未传 --start-time 时，默认用接口允许的最早起点：当前时刻起往回 180 天；若设为数字则按最近 N 天，N 最大 180）
- PAYPAL_DISPUTE_STATE=

说明：PayPal「列出争议」接口要求 start_time 必须落在最近 180 天内（否则会 INVALID_START_TIME_RANGE），无法通过该接口一次性拉 180 天之前的争议。

用法（无需命令行参数即可拉最近 180 天内尽量全的列表；数据来自 GET /v1/customer/disputes 分页）：
- python3 jobs/sync_paypal_disputes.py（不写详情接口；配置好 PAYPAL_* 与 DB_* 即可）
- python3 jobs/sync_paypal_disputes.py --lookback-days 30（仅最近 30 天）
- python3 jobs/sync_paypal_disputes.py --start-time 2026-04-01T00:00:00Z --end-time 2026-05-01T00:00:00Z
- python3 jobs/sync_paypal_disputes.py --dispute-state OPEN_INQUIRIES --fetch-detail
- python3 jobs/sync_paypal_disputes.py --dry-run

超半年无法用列表接口时，可按 dispute_id 仅调详情并 upsert：
- python3 jobs/sync_paypal_disputes.py --dispute-ids PP-R-XXX-123,PP-R-YYY-456
- python3 jobs/sync_paypal_disputes.py --backfill-builtin-dispute-ids（使用脚本内建 ID 数组）
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Set, Tuple

import pymysql
import requests
from dotenv import load_dotenv

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

PAYPAL_BASE_URL = (os.getenv("PAYPAL_BASE_URL") or "https://api-m.paypal.com").rstrip("/")
PAGE_SIZE_DEFAULT = int(os.getenv("PAYPAL_DISPUTE_PAGE_SIZE", "50") or "50")
# https://developer.paypal.com/docs/api/customer-disputes/v1/ — start_time 必须在最近 180 天内。
PAYPAL_LIST_START_MAX_LOOKBACK_DAYS = 180
DEFAULT_DISPUTE_STATE = (os.getenv("PAYPAL_DISPUTE_STATE") or "").strip()

# 列表接口时间窗外需按 ID 补拉详情的争议（维护在此元组即可）
BUILTIN_DISPUTE_IDS_BACKFILL: Tuple[str, ...] = (
    "PP-R-BPP-576108228",
    "PP-R-PTR-577158064",
    "PP-R-YAA-577290787",
    "PP-R-OWV-577291017",
    "PP-R-NAY-577473717",
    "PP-R-EEY-577592148",
    "PP-R-AWI-577617874",
    "PP-R-VPZ-577668191",
    "PP-R-XIX-577887078",
    "PP-R-ZGY-578068594",
    "PP-R-BRC-578335810",
    "PP-R-YIG-578850829",
    "PP-R-QCT-579216967",
    "PP-R-FYZ-579222547",
    "PP-R-AVE-579376691",
    "PP-R-ILV-579616252",
    "PP-R-UUB-579805003",
    "PP-R-NYP-579911317",
    "PP-R-FNX-580022889",
    "PP-R-EMV-580068071",
    "PP-R-WBB-580068077",
    "PP-R-OWF-580080970",
    "PP-R-ENF-580724488",
    "PP-R-HKL-580855881",
    "PP-R-DEB-580859361",
    "PP-R-QLQ-581047357",
    "PP-R-UCF-581214656",
    "PP-R-DAP-581773747",
    "PP-R-WJQ-582295857",
    "PP-R-KII-582391042",
    "PP-R-XXH-582393618",
    "PP-R-OAJ-582450697",
    "PP-R-KIM-582558884",
    "PP-R-WXY-582571039",
    "PP-R-LZC-582625785",
    "PP-R-ZMS-582712108",
    "PP-R-JAK-582733958",
    "PP-R-TRA-583148840",
    "PP-R-SAQ-583148875",
    "PP-R-CCL-583863612",
    "PP-R-SFZ-583988470",
    "PP-R-LIL-584551107",
    "PP-R-BZV-585770147",
    "PP-R-RJD-586479401",
    "PP-R-JWF-588064698",
    "PP-R-IIP-601902467",
)


def default_lookback_days_from_env() -> Optional[int]:
    raw = (os.getenv("PAYPAL_DISPUTE_LOOKBACK_DAYS") or "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if value:
        return value
    logger.error("请配置环境变量 %s", name)
    raise SystemExit(1)


def clamp_page_size(size: int) -> int:
    # PayPal disputes list API page_size 最大 50。
    if size < 1:
        return 1
    if size > 50:
        return 50
    return size


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def earliest_allowed_list_start() -> datetime:
    """List disputes 允许的最早 create_time_after（约当前 UTC 往前 180 天）。

    实测恰好卡在 now-180d 边界会触发 INVALID_START_TIME_RANGE，故向前偏移一小段，落在官方允许的「最近 180 天」之内。
    """
    return now_utc() - timedelta(days=PAYPAL_LIST_START_MAX_LOOKBACK_DAYS) + timedelta(minutes=5)


def to_paypal_time(dt: datetime) -> str:
    # Some PayPal Disputes tenants reject second-only timestamps; always send millisecond precision.
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso8601(value: str, field_name: str) -> datetime:
    text = value.strip()
    if not text:
        raise ValueError(f"{field_name} 为空")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def resolve_time_window(
    start_time: Optional[str],
    end_time: Optional[str],
    lookback_days: Optional[int],
) -> Tuple[str, Optional[str]]:
    earliest = earliest_allowed_list_start()

    if start_time:
        start_dt = parse_iso8601(start_time, "start_time")
    elif lookback_days is not None:
        lb = lookback_days
        if lb < 1:
            lb = 1
        if lb > PAYPAL_LIST_START_MAX_LOOKBACK_DAYS:
            lb = PAYPAL_LIST_START_MAX_LOOKBACK_DAYS
        start_dt = now_utc() - timedelta(days=lb)
    else:
        # 不传 start / lookback 时：用接口允许的最早时刻，等价于「最近 180 天」整段。
        start_dt = earliest

    if start_dt < earliest:
        logger.warning(
            "起始时间早于 PayPal 允许的最早时间（当前起约 %s 天内），已改为 %s",
            PAYPAL_LIST_START_MAX_LOOKBACK_DAYS,
            to_paypal_time(earliest),
        )
        start_dt = earliest

    end_dt: Optional[datetime] = None
    if end_time:
        end_dt = parse_iso8601(end_time, "end_time")

    if end_dt and end_dt <= start_dt:
        raise ValueError("end_time 必须大于 start_time")

    return to_paypal_time(start_dt), to_paypal_time(end_dt) if end_dt else None


def get_access_token(session: requests.Session, client_id: str, client_secret: str) -> str:
    url = f"{PAYPAL_BASE_URL}/v1/oauth2/token"
    response = session.post(
        url,
        data={"grant_type": "client_credentials"},
        auth=(client_id, client_secret),
        headers={"Accept": "application/json", "Accept-Language": "en_US"},
        timeout=60,
    )
    if response.status_code >= 400:
        logger.error("获取 PayPal access_token 失败：status=%s body=%s", response.status_code, response.text[:600])
        response.raise_for_status()

    data = response.json()
    token = str(data.get("access_token") or "").strip()
    if not token:
        logger.error("PayPal OAuth2 响应缺少 access_token：%s", json.dumps(data, ensure_ascii=False)[:600])
        raise SystemExit(1)
    return token


def pick_str(payload: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        if key not in payload:
            continue
        value = payload.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def first_disputed_transaction(dispute: Dict[str, Any]) -> Dict[str, Any]:
    rows = dispute.get("disputed_transactions")
    if isinstance(rows, list) and rows:
        first = rows[0]
        if isinstance(first, dict):
            tx_info = first.get("transaction_info")
            if isinstance(tx_info, dict):
                return tx_info
            return first
    return {}


def to_decimal_or_none(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def parse_db_datetime(value: str) -> Optional[datetime]:
    text = value.strip()
    if not text:
        return None
    try:
        return parse_iso8601(text, "db_time").replace(tzinfo=None)
    except Exception:
        return None


def build_dispute_row(dispute: Dict[str, Any]) -> Dict[str, Any]:
    tx = first_disputed_transaction(dispute)
    dispute_amount = dispute.get("dispute_amount") if isinstance(dispute.get("dispute_amount"), dict) else {}
    if not isinstance(dispute_amount, dict):
        dispute_amount = {}

    dispute_id = pick_str(dispute, "dispute_id", "id")
    if not dispute_id:
        return {}

    buyer_info = tx.get("buyer") if isinstance(tx.get("buyer"), dict) else {}
    seller_info = tx.get("seller") if isinstance(tx.get("seller"), dict) else {}

    create_time = pick_str(dispute, "create_time")
    update_time = pick_str(dispute, "update_time")

    return {
        "dispute_id": dispute_id,
        "dispute_state": pick_str(dispute, "dispute_state", "status", "state"),
        "dispute_stage": pick_str(dispute, "dispute_life_cycle_stage", "life_cycle_stage"),
        "dispute_channel": pick_str(dispute, "dispute_channel"),
        "dispute_reason": pick_str(dispute, "reason", "dispute_reason"),
        "dispute_outcome": pick_str(dispute, "outcome"),
        "dispute_amount_currency": pick_str(dispute_amount, "currency_code", "currency"),
        "dispute_amount_value": to_decimal_or_none(dispute_amount.get("value")),
        "create_time": parse_db_datetime(create_time),
        "update_time": parse_db_datetime(update_time),
        "buyer_transaction_id": pick_str(
            tx,
            "buyer_transaction_id",
            "transaction_id",
            "reference_id",
        ),
        "seller_transaction_id": pick_str(tx, "seller_transaction_id"),
        "invoice_id": pick_str(tx, "invoice_id", "invoice_number", "custom"),
        "buyer_payer_id": pick_str(buyer_info, "payer_id"),
        "seller_merchant_id": pick_str(seller_info, "merchant_id"),
    }


def extract_buyer_evidence_notes(detail: Optional[Dict[str, Any]]) -> Optional[str]:
    """INTERNAL 争议且详情含 evidences 时，取第一条 evidence 的 notes；否则 None。"""
    if not detail:
        return None
    if pick_str(detail, "dispute_channel").upper() != "INTERNAL":
        return None
    evidences = detail.get("evidences")
    if not isinstance(evidences, list) or not evidences:
        return None
    first = evidences[0]
    if not isinstance(first, dict):
        return None
    notes = first.get("notes")
    if notes is None:
        return None
    text = str(notes).strip()
    return text if text else None


def ensure_table(cursor) -> None:
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS paypal_disputes (
            id BIGINT NOT NULL AUTO_INCREMENT,
            dispute_id VARCHAR(64) NOT NULL,
            dispute_state VARCHAR(64) DEFAULT NULL,
            dispute_stage VARCHAR(64) DEFAULT NULL,
            dispute_channel VARCHAR(64) DEFAULT NULL,
            dispute_reason VARCHAR(128) DEFAULT NULL,
            dispute_outcome VARCHAR(64) DEFAULT NULL,
            dispute_amount_currency VARCHAR(16) DEFAULT NULL,
            dispute_amount_value DECIMAL(18,6) DEFAULT NULL,
            create_time DATETIME DEFAULT NULL,
            update_time DATETIME DEFAULT NULL,
            buyer_transaction_id VARCHAR(64) DEFAULT NULL,
            seller_transaction_id VARCHAR(64) DEFAULT NULL,
            invoice_id VARCHAR(127) DEFAULT NULL,
            buyer_payer_id VARCHAR(64) DEFAULT NULL,
            seller_merchant_id VARCHAR(64) DEFAULT NULL,
            raw_payload LONGTEXT,
            detail_payload LONGTEXT COMMENT 'GET /v1/customer/disputes/{id} 完整 JSON（仅 --fetch-detail 时写入）',
            buyer_evidence_notes TEXT COMMENT 'INTERNAL 且详情 evidences[0].notes（--fetch-detail）',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uk_dispute_id (dispute_id),
            KEY idx_state (dispute_state),
            KEY idx_update_time (update_time),
            KEY idx_buyer_tx (buyer_transaction_id),
            KEY idx_seller_tx (seller_transaction_id),
            KEY idx_invoice_id (invoice_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        """
    )
    cursor.execute(
        """
        SELECT COUNT(1) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'paypal_disputes' AND column_name = 'detail_payload'
        """
    )
    if cursor.fetchone()[0] == 0:
        cursor.execute(
            "ALTER TABLE paypal_disputes ADD COLUMN detail_payload LONGTEXT NULL "
            "COMMENT 'GET /v1/customer/disputes/{id} 完整 JSON' AFTER raw_payload"
        )
    cursor.execute(
        """
        SELECT COUNT(1) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'paypal_disputes' AND column_name = 'buyer_evidence_notes'
        """
    )
    if cursor.fetchone()[0] == 0:
        cursor.execute(
            "ALTER TABLE paypal_disputes ADD COLUMN buyer_evidence_notes TEXT NULL "
            "COMMENT 'INTERNAL 详情 evidences[0].notes' AFTER detail_payload"
        )


def upsert_dispute(cursor, row: Dict[str, Any]) -> int:
    sql = """
    INSERT INTO paypal_disputes (
      dispute_id,
      dispute_state,
      dispute_stage,
      dispute_channel,
      dispute_reason,
      dispute_outcome,
      dispute_amount_currency,
      dispute_amount_value,
      create_time,
      update_time,
      buyer_transaction_id,
      seller_transaction_id,
      invoice_id,
      buyer_payer_id,
      seller_merchant_id,
      raw_payload,
      detail_payload,
      buyer_evidence_notes
    ) VALUES (
      %(dispute_id)s,
      %(dispute_state)s,
      %(dispute_stage)s,
      %(dispute_channel)s,
      %(dispute_reason)s,
      %(dispute_outcome)s,
      %(dispute_amount_currency)s,
      %(dispute_amount_value)s,
      %(create_time)s,
      %(update_time)s,
      %(buyer_transaction_id)s,
      %(seller_transaction_id)s,
      %(invoice_id)s,
      %(buyer_payer_id)s,
      %(seller_merchant_id)s,
      %(raw_payload)s,
      %(detail_payload)s,
      %(buyer_evidence_notes)s
    )
    ON DUPLICATE KEY UPDATE
      dispute_state = VALUES(dispute_state),
      dispute_stage = VALUES(dispute_stage),
      dispute_channel = VALUES(dispute_channel),
      dispute_reason = VALUES(dispute_reason),
      dispute_outcome = VALUES(dispute_outcome),
      dispute_amount_currency = VALUES(dispute_amount_currency),
      dispute_amount_value = VALUES(dispute_amount_value),
      create_time = VALUES(create_time),
      update_time = VALUES(update_time),
      buyer_transaction_id = VALUES(buyer_transaction_id),
      seller_transaction_id = VALUES(seller_transaction_id),
      invoice_id = VALUES(invoice_id),
      buyer_payer_id = VALUES(buyer_payer_id),
      seller_merchant_id = VALUES(seller_merchant_id),
      raw_payload = VALUES(raw_payload),
      detail_payload = COALESCE(VALUES(detail_payload), detail_payload),
      buyer_evidence_notes = IF(
        VALUES(detail_payload) IS NOT NULL,
        VALUES(buyer_evidence_notes),
        buyer_evidence_notes
      )
    """
    cursor.execute(sql, row)
    return cursor.rowcount


def fetch_dispute_detail(
    session: requests.Session,
    headers: Dict[str, str],
    dispute_id: str,
) -> Dict[str, Any]:
    url = f"{PAYPAL_BASE_URL}/v1/customer/disputes/{dispute_id}"
    response = session.get(url, headers=headers, timeout=60)
    if response.status_code >= 400:
        logger.warning("拉取争议详情失败 dispute_id=%s status=%s", dispute_id, response.status_code)
        return {}
    data = response.json()
    return data if isinstance(data, dict) else {}


def list_disputes(
    session: requests.Session,
    headers: Dict[str, str],
    create_time_after: str,
    create_time_before: Optional[str],
    dispute_state: str,
    page_size: int,
    max_pages: int,
    fetch_detail: bool,
) -> Tuple[List[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]], Dict[str, int]]:
    endpoint = f"{PAYPAL_BASE_URL}/v1/customer/disputes"
    rows: List[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]] = []
    stats = {"pages": 0, "api_items": 0, "detail_calls": 0, "empty_dispute_id": 0}

    page = 1
    next_page_token = ""
    while True:
        # 使用 create_time_*；start_time / end_time 已弃用且易出现 INVALID_START_TIME_RANGE。
        params: Dict[str, Any] = {
            "page_size": page_size,
            "create_time_after": create_time_after,
        }
        if create_time_before:
            params["create_time_before"] = create_time_before
        if dispute_state:
            params["dispute_state"] = dispute_state

        if next_page_token:
            params["next_page_token"] = next_page_token

        response = session.get(endpoint, headers=headers, params=params, timeout=60)
        if response.status_code >= 400:
            logger.error(
                "请求 PayPal disputes 列表失败: status=%s params=%s body=%s",
                response.status_code,
                params,
                response.text[:800],
            )
            response.raise_for_status()

        payload = response.json()
        items = payload.get("items") if isinstance(payload, dict) else []
        if not isinstance(items, list):
            items = []

        stats["pages"] += 1
        stats["api_items"] += len(items)

        if not items:
            break

        for item in items:
            if not isinstance(item, dict):
                continue
            dispute_id = pick_str(item, "dispute_id", "id")
            if not dispute_id:
                stats["empty_dispute_id"] += 1
                continue

            detail_opt: Optional[Dict[str, Any]] = None
            if fetch_detail:
                detail_opt = fetch_dispute_detail(session, headers, dispute_id)
                stats["detail_calls"] += 1
                if not detail_opt or not pick_str(detail_opt, "dispute_id", "id"):
                    detail_opt = None
            rows.append((item, detail_opt))

        next_page_token = pick_str(payload, "next_page_token")
        if next_page_token:
            if max_pages > 0 and stats["pages"] >= max_pages:
                logger.info("达到 max_pages=%s，提前结束分页", max_pages)
                break
            continue

        if len(items) < page_size:
            break

        page += 1
        if max_pages > 0 and stats["pages"] >= max_pages:
            logger.info("达到 max_pages=%s，提前结束分页", max_pages)
            break

    return rows, stats


def parse_dispute_id_list(raw: str) -> List[str]:
    """逗号/换行分隔的 dispute_id，去空白、去重（保序）。"""
    seen: Set[str] = set()
    out: List[str] = []
    for chunk in raw.replace("\n", ",").split(","):
        s = chunk.strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def persist_dispute_rows(rows: List[Dict[str, Any]], dry_run: bool, stats: Dict[str, int]) -> None:
    stats["db_insert_or_update"] = 0
    stats["db_skipped"] = 0
    if dry_run:
        logger.info("[dry-run] 解析到 %s 条争议，跳过数据库写入", len(rows))
        return
    if not MYSQL_CONFIG["database"]:
        logger.error("请配置 DB_NAME")
        raise SystemExit(1)

    conn = pymysql.connect(**MYSQL_CONFIG)
    cursor = conn.cursor()
    try:
        ensure_table(cursor)
        conn.commit()

        for row in rows:
            affected = upsert_dispute(cursor, row)
            if affected > 0:
                stats["db_insert_or_update"] += 1
            else:
                stats["db_skipped"] += 1

        conn.commit()
    finally:
        cursor.close()
        conn.close()


def sync_disputes_by_ids(dispute_ids: List[str], dry_run: bool) -> Dict[str, int]:
    """仅 GET /v1/customer/disputes/{id} 并 upsert，用于列表接口时间窗口外的争议。"""
    stats: Dict[str, int] = {
        "pages": 0,
        "api_items": len(dispute_ids),
        "detail_calls": 0,
        "empty_dispute_id": 0,
        "detail_fetch_failed": 0,
        "db_insert_or_update": 0,
        "db_skipped": 0,
    }
    client_id = require_env("PAYPAL_CLIENT_ID")
    client_secret = require_env("PAYPAL_CLIENT_SECRET")

    session = requests.Session()
    token = get_access_token(session, client_id, client_secret)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    rows: List[Dict[str, Any]] = []
    for did in dispute_ids:
        detail_opt = fetch_dispute_detail(session, headers, did)
        stats["detail_calls"] += 1
        if not detail_opt or not pick_str(detail_opt, "dispute_id", "id"):
            stats["detail_fetch_failed"] += 1
            logger.warning("按 ID 拉取争议详情失败 dispute_id=%s", did)
            continue

        list_item = {"dispute_id": did, "_source": "dispute_ids_backfill"}
        row = build_dispute_row(detail_opt)
        if not row:
            stats["empty_dispute_id"] += 1
            continue
        row["raw_payload"] = json.dumps(list_item, ensure_ascii=False, default=str)
        row["detail_payload"] = json.dumps(detail_opt, ensure_ascii=False, default=str)
        row["buyer_evidence_notes"] = extract_buyer_evidence_notes(detail_opt)
        rows.append(row)

    persist_dispute_rows(rows, dry_run, stats)
    return stats


def sync_disputes(
    start_time: str,
    end_time: Optional[str],
    dispute_state: str,
    page_size: int,
    max_pages: int,
    dry_run: bool,
    fetch_detail: bool,
) -> Dict[str, int]:
    client_id = require_env("PAYPAL_CLIENT_ID")
    client_secret = require_env("PAYPAL_CLIENT_SECRET")

    session = requests.Session()
    token = get_access_token(session, client_id, client_secret)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    disputes, stats = list_disputes(
        session=session,
        headers=headers,
        create_time_after=start_time,
        create_time_before=end_time,
        dispute_state=dispute_state,
        page_size=page_size,
        max_pages=max_pages,
        fetch_detail=fetch_detail,
    )

    rows = []
    for list_item, detail_opt in disputes:
        source = detail_opt if detail_opt else list_item
        row = build_dispute_row(source)
        if not row:
            stats["empty_dispute_id"] += 1
            continue
        row["raw_payload"] = json.dumps(list_item, ensure_ascii=False, default=str)
        row["detail_payload"] = (
            json.dumps(detail_opt, ensure_ascii=False, default=str) if detail_opt else None
        )
        row["buyer_evidence_notes"] = extract_buyer_evidence_notes(detail_opt)
        rows.append(row)

    persist_dispute_rows(rows, dry_run, stats)
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync PayPal disputes into MySQL")
    parser.add_argument("--start-time", default="", help="ISO8601, 例如 2026-05-01T00:00:00Z")
    parser.add_argument("--end-time", default="", help="ISO8601, 例如 2026-05-11T00:00:00Z")
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=None,
        metavar="N",
        help="未传 --start-time 时仅同步最近 N 天（1-180）；不传则默认从当前起最早可查询时刻起（180 天窗口）（也可用环境变量 PAYPAL_DISPUTE_LOOKBACK_DAYS）",
    )
    parser.add_argument("--dispute-state", default=DEFAULT_DISPUTE_STATE, help="可选：OPEN_INQUIRIES / OPEN_CLAIMS / RESOLVED")
    parser.add_argument("--page-size", type=int, default=PAGE_SIZE_DEFAULT, help="每页数量（1-50）")
    parser.add_argument("--max-pages", type=int, default=0, help="最多拉取页数，0 表示不限制")
    parser.add_argument(
        "--fetch-detail",
        action="store_true",
        help="逐条 GET 详情；结构化列以详情为准，raw_payload 存列表项 JSON，detail_payload 存详情全文",
    )
    parser.add_argument("--dry-run", action="store_true", help="只拉取不写库")
    parser.add_argument(
        "--dispute-ids",
        default="",
        help="逗号分隔 dispute_id，仅 GET 详情并 upsert（跳过列表时间窗口）",
    )
    parser.add_argument(
        "--backfill-builtin-dispute-ids",
        action="store_true",
        help="使用脚本内建 BUILTIN_DISPUTE_IDS_BACKFILL 仅拉详情并 upsert",
    )
    args = parser.parse_args()

    if args.backfill_builtin_dispute_ids:
        ids = list(BUILTIN_DISPUTE_IDS_BACKFILL)
        logger.info(
            "按 dispute_id 仅拉详情（内建数组）：base=%s count=%s dry_run=%s",
            PAYPAL_BASE_URL,
            len(ids),
            args.dry_run,
        )
        stats = sync_disputes_by_ids(ids, dry_run=args.dry_run)
        logger.info(
            "完成：detail_calls=%s detail_fetch_failed=%s empty_dispute_id=%s db_insert_or_update=%s db_skipped=%s",
            stats.get("detail_calls", 0),
            stats.get("detail_fetch_failed", 0),
            stats.get("empty_dispute_id", 0),
            stats.get("db_insert_or_update", 0),
            stats.get("db_skipped", 0),
        )
        return

    ids_raw = (args.dispute_ids or "").strip()
    if ids_raw:
        ids = parse_dispute_id_list(ids_raw)
        if not ids:
            logger.error("--dispute-ids 解析后为空")
            raise SystemExit(1)
        logger.info(
            "按 dispute_id 仅拉详情：base=%s count=%s dry_run=%s",
            PAYPAL_BASE_URL,
            len(ids),
            args.dry_run,
        )
        stats = sync_disputes_by_ids(ids, dry_run=args.dry_run)
        logger.info(
            "完成：detail_calls=%s detail_fetch_failed=%s empty_dispute_id=%s db_insert_or_update=%s db_skipped=%s",
            stats.get("detail_calls", 0),
            stats.get("detail_fetch_failed", 0),
            stats.get("empty_dispute_id", 0),
            stats.get("db_insert_or_update", 0),
            stats.get("db_skipped", 0),
        )
        return

    fetch_detail = args.fetch_detail
    page_size = clamp_page_size(args.page_size)

    lookback_days = args.lookback_days
    if lookback_days is None:
        lookback_days = default_lookback_days_from_env()

    try:
        start_time, end_time = resolve_time_window(
            start_time=args.start_time,
            end_time=args.end_time,
            lookback_days=lookback_days,
        )
    except Exception as exc:
        logger.error("时间参数错误：%s", exc)
        raise SystemExit(1)

    logger.info(
        "开始同步 PayPal disputes：base=%s start=%s end=%s state=%s page_size=%s fetch_detail=%s dry_run=%s",
        PAYPAL_BASE_URL,
        start_time,
        end_time or "-",
        args.dispute_state or "-",
        page_size,
        fetch_detail,
        args.dry_run,
    )

    stats = sync_disputes(
        start_time=start_time,
        end_time=end_time,
        dispute_state=args.dispute_state.strip(),
        page_size=page_size,
        max_pages=max(0, args.max_pages),
        dry_run=args.dry_run,
        fetch_detail=fetch_detail,
    )

    logger.info(
        "完成：pages=%s api_items=%s detail_calls=%s empty_dispute_id=%s db_insert_or_update=%s db_skipped=%s",
        stats.get("pages", 0),
        stats.get("api_items", 0),
        stats.get("detail_calls", 0),
        stats.get("empty_dispute_id", 0),
        stats.get("db_insert_or_update", 0),
        stats.get("db_skipped", 0),
    )


if __name__ == "__main__":
    main()
