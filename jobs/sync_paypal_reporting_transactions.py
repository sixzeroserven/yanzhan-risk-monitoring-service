"""
从 PayPal Transaction Search（Reporting）API 拉取交易记录，按 transaction_event_code（T 码）筛选后写入 MySQL。

接口：GET /v1/reporting/transactions
文档：https://developer.paypal.com/docs/api/transaction-search/v1/
T 码参考：https://developer.paypal.com/docs/reports/reference/tcodes/

约束：
- start_date / end_date 单次请求跨度最多 31 天；本脚本自动按 31 天切片循环。
- 默认 T 码：拒付处理费、争议费、PayPal 撤销、商家退款、费用冲正/退回、拒付及 PACMAN 相关、以及可选的授权类（见 DEFAULT_REPORTING_EVENT_CODES）；可用 --event-codes 或 PAYPAL_REPORTING_EVENT_CODES 覆盖。
- PAYPAL_REPORTING_EXCLUDE_AUTH_TCODES=1：从默认集合中去掉 T1300/T1301/T1302（授权量大，多数对账可不开）。

环境变量（与 disputes 脚本共用）：
- PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
- PAYPAL_BASE_URL（默认 https://api-m.paypal.com）
- 多账号推荐：PAYPAL_ACCOUNTS_JSON 或 PAYPAL_ACCOUNT_KEYS（每个账号可配独立 PAYPAL_xxx_PROXY_URL）
- PAYPAL_PROXY_URL（单账号兼容模式；HTTP/HTTPS 代理地址）
- PAYPAL_REPORTING_PAGE_SIZE（默认 500，最大 500）
- PAYPAL_REPORTING_EVENT_CODES（可选，逗号分隔，覆盖默认 T 码集合）
- PAYPAL_REPORTING_MAX_BACKFILL_DAYS（无参默认回溯天数，默认与 API 窗口一致，见下）
- PAYPAL_REPORTING_API_MAX_HISTORY_DAYS（Reporting 允许的最早 start_date 距「当前」约多少天，默认 1095≈3 年）
- PAYPAL_REPORTING_HTTP_READ_TIMEOUT（Reporting GET 单次读超时秒数，默认 300）
- PAYPAL_REPORTING_HTTP_CONNECT_TIMEOUT（连接超时秒数，默认 30）
- PAYPAL_REPORTING_HTTP_RETRIES（读超时/连接失败时最多尝试次数，默认 5）
- PAYPAL_REPORTING_REQUEST_DELAY_SECONDS（每次 Reporting GET 前等待秒数，默认 1，避免触发限流）
- PAYPAL_REPORTING_RATE_LIMIT_RETRIES（遇到 429 时最多尝试次数，默认 8）
- PAYPAL_REPORTING_RATE_LIMIT_BASE_DELAY_SECONDS（429 无 Retry-After 时的初始等待秒数，默认 60）
- PAYPAL_REPORTING_RATE_LIMIT_MAX_DELAY_SECONDS（429 最大等待秒数，默认 900）

建表：
  - 推荐：在 MySQL 中执行仓库内 `sql/init.sql` 里 `paypal_reporting_transactions` 的 DDL；或 `npx prisma db push`（需配置 DATABASE_URL）。
  - 脚本首次写库时也会 `CREATE TABLE IF NOT EXISTS`（与上述 DDL 一致），表已存在则跳过。

不传日期类 CLI 参数时（可配合 --dry-run / --page-size / --event-codes）：
  - 默认：从当前 UTC 起向过去同步上述默认 T 码；回溯天数取 min(配置, Reporting API 约 3 年窗口)。

用法：
  python3 jobs/sync_paypal_reporting_transactions.py
  python3 jobs/sync_paypal_reporting_transactions.py --max-backfill-days 1095
  python3 jobs/sync_paypal_reporting_transactions.py --start-date 2025-01-01T00:00:00Z --end-date 2025-02-01T00:00:00Z
  python3 jobs/sync_paypal_reporting_transactions.py --lookback-days 30
  python3 jobs/sync_paypal_reporting_transactions.py --lookback-days 7 --event-codes T1107,T1201 --dry-run
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from email.utils import parsedate_to_datetime
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import pymysql
import requests
from dotenv import load_dotenv
from paypal_accounts import (
    PayPalAccount,
    fetch_account_egress_ip,
    make_paypal_session,
    mask_proxy_url,
    select_paypal_accounts,
)

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

REPORTING_PAGE_SIZE_DEFAULT = min(500, max(1, int(os.getenv("PAYPAL_REPORTING_PAGE_SIZE", "200") or "500")))
API_MAX_RANGE_DAYS = 31
REPORTING_API_MAX_HISTORY_DAYS_DEFAULT = 1095

DEFAULT_REPORTING_EVENT_CODES: Tuple[str, ...] = (
    "T0106",
    "T0114",
    "T1106",
    "T1107",
    "T1108",
    "T1109",
    "T1201",
    "T1202",
    "T1205",
    "T1207",
    "T1208",
)

_AUTH_TCODES = frozenset({"T1300", "T1301", "T1302"})


def reporting_http_connect_timeout() -> float:
    raw = (os.getenv("PAYPAL_REPORTING_HTTP_CONNECT_TIMEOUT") or "30").strip()
    try:
        v = float(raw)
    except ValueError:
        v = 30.0
    return max(5.0, min(v, 120.0))


def reporting_http_read_timeout() -> float:
    raw = (os.getenv("PAYPAL_REPORTING_HTTP_READ_TIMEOUT") or "300").strip()
    try:
        v = float(raw)
    except ValueError:
        v = 300.0
    return max(30.0, min(v, 900.0))


def reporting_http_retries() -> int:
    raw = (os.getenv("PAYPAL_REPORTING_HTTP_RETRIES") or "5").strip()
    try:
        v = int(raw)
    except ValueError:
        v = 5
    return max(1, min(v, 15))


def reporting_request_delay_seconds() -> float:
    raw = (os.getenv("PAYPAL_REPORTING_REQUEST_DELAY_SECONDS") or "1").strip()
    try:
        v = float(raw)
    except ValueError:
        v = 1.0
    return max(0.0, min(v, 60.0))


def reporting_rate_limit_retries() -> int:
    raw = (os.getenv("PAYPAL_REPORTING_RATE_LIMIT_RETRIES") or "8").strip()
    try:
        v = int(raw)
    except ValueError:
        v = 8
    return max(1, min(v, 30))


def reporting_rate_limit_base_delay_seconds() -> float:
    raw = (os.getenv("PAYPAL_REPORTING_RATE_LIMIT_BASE_DELAY_SECONDS") or "60").strip()
    try:
        v = float(raw)
    except ValueError:
        v = 60.0
    return max(1.0, min(v, 3600.0))


def reporting_rate_limit_max_delay_seconds() -> float:
    raw = (os.getenv("PAYPAL_REPORTING_RATE_LIMIT_MAX_DELAY_SECONDS") or "900").strip()
    try:
        v = float(raw)
    except ValueError:
        v = 900.0
    return max(1.0, min(v, 7200.0))


def retry_after_delay_seconds(response: requests.Response) -> Optional[float]:
    raw = (response.headers.get("Retry-After") or "").strip()
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        retry_at = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    return max(0.0, (retry_at.astimezone(timezone.utc) - now_utc()).total_seconds())


def rate_limit_backoff_seconds(response: requests.Response, attempt: int) -> float:
    retry_after = retry_after_delay_seconds(response)
    if retry_after is not None:
        return min(retry_after, reporting_rate_limit_max_delay_seconds())
    delay = reporting_rate_limit_base_delay_seconds() * (2 ** (attempt - 1))
    return min(delay, reporting_rate_limit_max_delay_seconds())


def default_reporting_event_codes() -> Tuple[str, ...]:
    raw = (os.getenv("PAYPAL_REPORTING_EXCLUDE_AUTH_TCODES") or "").strip().lower()
    if raw in ("1", "true", "yes", "y", "on"):
        return tuple(c for c in DEFAULT_REPORTING_EVENT_CODES if c not in _AUTH_TCODES)
    return DEFAULT_REPORTING_EVENT_CODES


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def to_paypal_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso_z(s: str, label: str) -> datetime:
    t = s.strip()
    if not t:
        raise ValueError(f"{label} 为空")
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    d = datetime.fromisoformat(t)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def default_event_codes_from_env() -> Optional[Tuple[str, ...]]:
    raw = (os.getenv("PAYPAL_REPORTING_EVENT_CODES") or "").strip()
    if not raw:
        return None
    codes = [x.strip().upper() for x in raw.split(",") if x.strip()]
    return tuple(dict.fromkeys(codes))


def parse_event_codes_arg(raw: str) -> Optional[Tuple[str, ...]]:
    raw = (raw or "").strip()
    if not raw:
        return None
    codes = [x.strip().upper() for x in raw.split(",") if x.strip()]
    if not codes:
        return None
    return tuple(dict.fromkeys(codes))


def reporting_api_max_history_days() -> int:
    raw = (os.getenv("PAYPAL_REPORTING_API_MAX_HISTORY_DAYS") or str(REPORTING_API_MAX_HISTORY_DAYS_DEFAULT)).strip()
    try:
        v = int(raw)
    except ValueError:
        v = REPORTING_API_MAX_HISTORY_DAYS_DEFAULT
    return max(1, min(v, 365 * 10))


def clamp_start_date_for_reporting(start: datetime) -> datetime:
    earliest = now_utc() - timedelta(days=reporting_api_max_history_days())
    if start < earliest:
        logger.warning(
            "Reporting API 仅允许 start_date 在最近约 %s 天内；已将起点从 %s 钳制为 %s",
            reporting_api_max_history_days(),
            to_paypal_z(start),
            to_paypal_z(earliest),
        )
        return earliest
    return start


def max_backfill_days_resolved(cli_value: Optional[int]) -> int:
    api_cap = reporting_api_max_history_days()
    if cli_value is not None:
        v = int(cli_value)
    else:
        raw = (os.getenv("PAYPAL_REPORTING_MAX_BACKFILL_DAYS") or str(api_cap)).strip()
        try:
            v = int(raw)
        except ValueError:
            v = api_cap
    return max(1, min(v, api_cap))


def iter_date_chunks(start: datetime, end: datetime, max_days: int = API_MAX_RANGE_DAYS) -> Iterable[Tuple[datetime, datetime]]:
    if end <= start:
        raise ValueError("end 必须大于 start")
    cur = start
    delta = timedelta(days=max_days)
    while cur < end:
        chunk_end = min(cur + delta, end)
        yield cur, chunk_end
        cur = chunk_end


def get_access_token(session: requests.Session, account: PayPalAccount) -> str:
    url = f"{account.base_url}/v1/oauth2/token"
    timeout = (reporting_http_connect_timeout(), min(120.0, reporting_http_read_timeout()))
    r = session.post(
        url,
        data={"grant_type": "client_credentials"},
        auth=(account.client_id, account.client_secret),
        headers={"Accept": "application/json", "Accept-Language": "en_US"},
        timeout=timeout,
    )
    r.raise_for_status()
    data = r.json()
    tok = str(data.get("access_token") or "").strip()
    if not tok:
        raise SystemExit("OAuth2 响应缺少 access_token")
    return tok


def money_parts(obj: Any) -> Tuple[Optional[str], Optional[Decimal]]:
    if not isinstance(obj, dict):
        return None, None
    cur = str(obj.get("currency_code") or obj.get("currency") or "").strip() or None
    val = obj.get("value")
    if val is None:
        return cur, None
    try:
        return cur, Decimal(str(val).strip())
    except (InvalidOperation, ValueError):
        return cur, None


def ensure_table(cursor) -> None:
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS paypal_reporting_transactions (
            id BIGINT NOT NULL AUTO_INCREMENT,
            transaction_id VARCHAR(32) NOT NULL,
            transaction_event_code VARCHAR(8) NOT NULL,
            transaction_initiation_ts VARCHAR(32) NOT NULL COMMENT 'API 原始 initiation 时间串，用于唯一键',
            transaction_updated_ts VARCHAR(32) DEFAULT NULL,
            transaction_status VARCHAR(8) DEFAULT NULL,
            transaction_amount_currency VARCHAR(8) DEFAULT NULL,
            transaction_amount_value DECIMAL(18,6) DEFAULT NULL,
            fee_amount_currency VARCHAR(8) DEFAULT NULL,
            fee_amount_value DECIMAL(18,6) DEFAULT NULL,
            invoice_id VARCHAR(256) DEFAULT NULL,
            custom_field VARCHAR(256) DEFAULT NULL,
            paypal_reference_id VARCHAR(64) DEFAULT NULL,
            paypal_reference_id_type VARCHAR(16) DEFAULT NULL,
            transaction_subject VARCHAR(512) DEFAULT NULL,
            payer_account_id VARCHAR(64) DEFAULT NULL,
            payer_email VARCHAR(256) DEFAULT NULL,
            raw_payload LONGTEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uk_txn_event_init (transaction_id, transaction_event_code, transaction_initiation_ts),
            KEY idx_event_code (transaction_event_code),
            KEY idx_init_ts (transaction_initiation_ts),
            KEY idx_invoice (invoice_id(64)),
            KEY idx_custom (custom_field(64))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        """
    )


def build_row_from_detail(detail: Dict[str, Any], allowed_codes: Set[str]) -> Optional[Dict[str, Any]]:
    info = detail.get("transaction_info")
    if not isinstance(info, dict):
        return None
    tcode = str(info.get("transaction_event_code") or "").strip().upper()
    if not tcode or tcode not in allowed_codes:
        return None
    tid = str(info.get("transaction_id") or "").strip()
    init = str(info.get("transaction_initiation_date") or "").strip()
    if not tid or not init:
        return None

    payer = detail.get("payer_info") if isinstance(detail.get("payer_info"), dict) else {}
    payer_id = str(payer.get("account_id") or "").strip() or None
    payer_email = str(payer.get("email_address") or "").strip() or None

    tamt_cur, tamt_val = money_parts(info.get("transaction_amount"))
    fee_cur, fee_val = money_parts(info.get("fee_amount"))

    return {
        "transaction_id": tid[:32],
        "transaction_event_code": tcode[:8],
        "transaction_initiation_ts": init[:32],
        "transaction_updated_ts": (str(info.get("transaction_updated_date") or "").strip()[:32] or None),
        "transaction_status": (str(info.get("transaction_status") or "").strip()[:8] or None),
        "transaction_amount_currency": tamt_cur,
        "transaction_amount_value": tamt_val,
        "fee_amount_currency": fee_cur,
        "fee_amount_value": fee_val,
        "invoice_id": (str(info.get("invoice_id") or "").strip()[:256] or None),
        "custom_field": (str(info.get("custom_field") or "").strip()[:256] or None),
        "paypal_reference_id": (str(info.get("paypal_reference_id") or "").strip()[:64] or None),
        "paypal_reference_id_type": (str(info.get("paypal_reference_id_type") or "").strip()[:16] or None),
        "transaction_subject": (str(info.get("transaction_subject") or "").strip()[:512] or None),
        "payer_account_id": (payer_id[:64] if payer_id else None),
        "payer_email": (payer_email[:256] if payer_email else None),
        "raw_payload": json.dumps(detail, ensure_ascii=False, default=str),
    }


UPSERT_SQL = """
INSERT INTO paypal_reporting_transactions (
  transaction_id, transaction_event_code, transaction_initiation_ts, transaction_updated_ts,
  transaction_status, transaction_amount_currency, transaction_amount_value,
  fee_amount_currency, fee_amount_value, invoice_id, custom_field,
  paypal_reference_id, paypal_reference_id_type, transaction_subject,
  payer_account_id, payer_email, raw_payload
) VALUES (
  %(transaction_id)s, %(transaction_event_code)s, %(transaction_initiation_ts)s, %(transaction_updated_ts)s,
  %(transaction_status)s, %(transaction_amount_currency)s, %(transaction_amount_value)s,
  %(fee_amount_currency)s, %(fee_amount_value)s, %(invoice_id)s, %(custom_field)s,
  %(paypal_reference_id)s, %(paypal_reference_id_type)s, %(transaction_subject)s,
  %(payer_account_id)s, %(payer_email)s, %(raw_payload)s
)
ON DUPLICATE KEY UPDATE
  transaction_updated_ts = VALUES(transaction_updated_ts),
  transaction_status = VALUES(transaction_status),
  transaction_amount_currency = VALUES(transaction_amount_currency),
  transaction_amount_value = VALUES(transaction_amount_value),
  fee_amount_currency = VALUES(fee_amount_currency),
  fee_amount_value = VALUES(fee_amount_value),
  invoice_id = VALUES(invoice_id),
  custom_field = VALUES(custom_field),
  paypal_reference_id = VALUES(paypal_reference_id),
  paypal_reference_id_type = VALUES(paypal_reference_id_type),
  transaction_subject = VALUES(transaction_subject),
  payer_account_id = VALUES(payer_account_id),
  payer_email = VALUES(payer_email),
  raw_payload = VALUES(raw_payload)
"""


def fetch_transactions_page(
    session: requests.Session,
    headers: Dict[str, str],
    base_url: str,
    start_date: str,
    end_date: str,
    page: int,
    page_size: int,
    transaction_event_code: Optional[str],
) -> Tuple[List[Dict[str, Any]], int, int]:
    url = f"{base_url}/v1/reporting/transactions"
    params: Dict[str, Any] = {
        "start_date": start_date,
        "end_date": end_date,
        "page": page,
        "page_size": page_size,
        "fields": "all",
        "balance_affecting_records_only": "Y",
    }
    if transaction_event_code:
        params["transaction_event_code"] = transaction_event_code

    timeout = (reporting_http_connect_timeout(), reporting_http_read_timeout())
    network_max_attempts = reporting_http_retries()
    rate_limit_max_attempts = reporting_rate_limit_retries()
    max_attempts = max(network_max_attempts, rate_limit_max_attempts)
    data: Optional[Dict[str, Any]] = None
    for attempt in range(1, max_attempts + 1):
        try:
            request_delay = reporting_request_delay_seconds()
            if request_delay > 0:
                time.sleep(request_delay)
            r = session.get(url, headers=headers, params=params, timeout=timeout)
            if r.status_code == 429:
                if attempt >= rate_limit_max_attempts:
                    logger.error("Reporting API 限流重试耗尽 status=%s body=%s", r.status_code, r.text[:800])
                    r.raise_for_status()
                delay = rate_limit_backoff_seconds(r, attempt)
                logger.warning(
                    "Reporting API 触发限流 429 (第 %s/%s 次)，%.0fs 后重试：body=%s",
                    attempt,
                    rate_limit_max_attempts,
                    delay,
                    r.text[:800],
                )
                time.sleep(delay)
                continue
            if 500 <= r.status_code < 600:
                if attempt >= network_max_attempts:
                    logger.error("Reporting API 服务端错误重试耗尽 status=%s body=%s", r.status_code, r.text[:800])
                    r.raise_for_status()
                delay = min(120.0, 5.0 * (2 ** (attempt - 1)))
                logger.warning(
                    "Reporting API 服务端错误 status=%s (第 %s/%s 次)，%.0fs 后重试：body=%s",
                    r.status_code,
                    attempt,
                    network_max_attempts,
                    delay,
                    r.text[:800],
                )
                time.sleep(delay)
                continue
            if r.status_code >= 400:
                logger.error("Reporting API 失败 status=%s body=%s", r.status_code, r.text[:800])
                r.raise_for_status()
            data = r.json()
            break
        except (
            requests.exceptions.ReadTimeout,
            requests.exceptions.ConnectTimeout,
            requests.exceptions.ConnectionError,
        ) as e:
            if attempt >= network_max_attempts:
                raise
            delay = min(120.0, 5.0 * (2 ** (attempt - 1)))
            logger.warning(
                "Reporting GET 超时或连接失败 (第 %s/%s 次)，%.0fs 后重试: %s",
                attempt,
                network_max_attempts,
                delay,
                e,
            )
            time.sleep(delay)
    if not isinstance(data, dict):
        raise RuntimeError("Reporting GET 未返回 JSON 对象")  # pragma: no cover

    details = data.get("transaction_details")
    if not isinstance(details, list):
        details = []
    total_pages = int(data.get("total_pages") or 1)
    total_items = int(data.get("total_items") or len(details))
    return details, total_pages, total_items


def sync_reporting_range(
    account: PayPalAccount,
    start: datetime,
    end: datetime,
    event_codes: Tuple[str, ...],
    page_size: int,
    dry_run: bool,
) -> Dict[str, int]:
    stats = {
        "chunks": 0,
        "api_calls": 0,
        "rows_parsed": 0,
        "rows_filtered_out": 0,
        "rows_matched": 0,
        "db_upsert": 0,
        "db_errors": 0,
    }

    session = make_paypal_session(account)
    token = get_access_token(session, account)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    conn = None
    cursor = None
    if not dry_run:
        if not MYSQL_CONFIG["database"]:
            logger.error("请配置 DB_NAME")
            raise SystemExit(1)
        conn = pymysql.connect(**MYSQL_CONFIG)
        cursor = conn.cursor()
        ensure_table(cursor)
        conn.commit()

    try:
        for chunk_start, chunk_end in iter_date_chunks(start, end):
            sd = to_paypal_z(chunk_start)
            ed = to_paypal_z(chunk_end)
            for ec in event_codes:
                stats["chunks"] += 1
                allowed_one: Set[str] = {ec}
                logger.info("时间片 %s .. %s server_tcode=%s", sd, ed, ec)

                page = 1
                total_pages = 1
                while page <= total_pages:
                    stats["api_calls"] += 1
                    details, total_pages, total_items = fetch_transactions_page(
                        session, headers, account.base_url, sd, ed, page, page_size, ec
                    )
                    logger.info(
                        "  page=%s/%s total_items=%s 本页=%s",
                        page,
                        total_pages,
                        total_items,
                        len(details),
                    )
                    for detail in details:
                        if not isinstance(detail, dict):
                            continue
                        stats["rows_parsed"] += 1
                        row = build_row_from_detail(detail, allowed_one)
                        if not row:
                            stats["rows_filtered_out"] += 1
                            continue
                        stats["rows_matched"] += 1
                        if dry_run:
                            continue
                        assert cursor is not None
                        try:
                            cursor.execute(UPSERT_SQL, row)
                            stats["db_upsert"] += 1
                        except Exception as e:
                            stats["db_errors"] += 1
                            logger.warning("写入失败: %s row=%s", e, row.get("transaction_id"))
                    if conn is not None:
                        conn.commit()
                    page += 1
    finally:
        if cursor is not None:
            cursor.close()
        if conn is not None:
            conn.close()

    if dry_run:
        logger.info("[dry-run] 匹配 T 码行数=%s（未写库）", stats["rows_matched"])

    return stats


def log_account_egress_ip(account: PayPalAccount) -> None:
    try:
        ip = fetch_account_egress_ip(account)
    except requests.RequestException as exc:
        logger.warning("账号 %s 出口 IP 检测失败：%s", account.name, exc)
        return
    logger.info("账号 %s 出口 IP：%s", account.name, ip or "-")


def main() -> None:
    parser = argparse.ArgumentParser(description="PayPal Reporting 交易 → MySQL（按 T 码筛选）")
    parser.add_argument("--start-date", default="", help="ISO8601 UTC，如 2025-01-01T00:00:00Z")
    parser.add_argument("--end-date", default="", help="ISO8601 UTC；与 start-date 跨度可大于 31 天（自动切片）")
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=None,
        help="从当前 UTC 往前 N 天到当前（与 --start-date/--end-date 及默认全量回溯互斥）",
    )
    parser.add_argument(
        "--max-backfill-days",
        type=int,
        default=None,
        help="无 --lookback-days 且无起止日期时：从当前 UTC 起最多回溯多少天（默认受 Reporting API 约 3 年上限约束）",
    )
    parser.add_argument(
        "--event-codes",
        default="",
        help="逗号分隔 T 码，覆盖默认集合；每个 T 码单独带 transaction_event_code 请求 API",
    )
    parser.add_argument("--page-size", type=int, default=REPORTING_PAGE_SIZE_DEFAULT, help="1-500")
    parser.add_argument("--dry-run", action="store_true", help="只请求与解析，不写库")
    parser.add_argument(
        "--paypal-account",
        default="",
        help="只同步指定 PayPal 账号名；多个用逗号分隔。默认同步全部配置账号",
    )
    args = parser.parse_args()
    accounts = select_paypal_accounts(args.paypal_account)

    page_size = max(1, min(500, int(args.page_size or 500)))

    env_codes = default_event_codes_from_env()
    arg_codes = parse_event_codes_arg(args.event_codes)
    if arg_codes:
        event_codes: Tuple[str, ...] = arg_codes
    elif env_codes:
        event_codes = env_codes
    else:
        event_codes = default_reporting_event_codes()

    if args.lookback_days is not None and (args.start_date or args.end_date):
        logger.error("--lookback-days 与 --start-date/--end-date 不能同时使用")
        raise SystemExit(1)

    if args.start_date and args.end_date:
        start = parse_iso_z(args.start_date, "start_date")
        end = parse_iso_z(args.end_date, "end_date")
    elif args.start_date or args.end_date:
        logger.error("--start-date 与 --end-date 必须同时提供")
        raise SystemExit(1)
    elif args.lookback_days is not None:
        end = now_utc()
        start = end - timedelta(days=max(1, int(args.lookback_days)))
    else:
        end = now_utc()
        cap = max_backfill_days_resolved(args.max_backfill_days)
        start = end - timedelta(days=cap)
        logger.info(
            "默认模式：争议/拒付/退款及相关费用（含授权 T1300–T1302，可用 PAYPAL_REPORTING_EXCLUDE_AUTH_TCODES=1 排除），回溯最多 %s 天（%s .. %s）",
            cap,
            to_paypal_z(start),
            to_paypal_z(end),
        )

    if end <= start:
        logger.error("结束时间必须大于开始时间")
        raise SystemExit(1)

    start = clamp_start_date_for_reporting(start)
    if start >= end:
        logger.error(
            "在 Reporting API 约 %s 天历史窗口内无有效区间（请缩短 --lookback-days 或调整起止日期）",
            reporting_api_max_history_days(),
        )
        raise SystemExit(1)

    for account in accounts:
        logger.info(
            "Reporting 同步：account=%s base=%s proxy=%s T码数量=%s 示例=%s page_size=%s dry_run=%s",
            account.name,
            account.base_url,
            mask_proxy_url(account.proxy_url),
            len(event_codes),
            ",".join(event_codes[:8]) + ("..." if len(event_codes) > 8 else ""),
            page_size,
            args.dry_run,
        )

        stats = sync_reporting_range(account, start, end, event_codes, page_size, dry_run=args.dry_run)
        logger.info(
            "账号 %s 完成：时间片×T码=%s api_calls=%s rows_parsed=%s rows_filtered_out=%s rows_matched=%s db_upsert=%s db_errors=%s",
            account.name,
            stats["chunks"],
            stats["api_calls"],
            stats["rows_parsed"],
            stats["rows_filtered_out"],
            stats["rows_matched"],
            stats.get("db_upsert", 0),
            stats.get("db_errors", 0),
        )
        log_account_egress_ip(account)


if __name__ == "__main__":
    main()
