"""
Sync orders.black_state from Mabangerp order list.

This is not an official Mabangerp API integration. It calls the same browser
AJAX endpoint used by the order page, similar to jobs/crawl_orders.py.

Env:
  MABANG_COOKIE: full browser Cookie from www.mabangerp.com.

Mapping:
  platformOrderId -> orders.order_id
  isBlackUser=1   -> orders.black_state=1
  isBlackUser=2   -> orders.black_state=0
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl

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

API_URL = "https://www.mabangerp.com/index.php?mod=order.oTc"
PAGE_SIZE = 100
REQUEST_INTERVAL = 0.5
MAX_RETRIES = 3
DEFAULT_LOOKBACK_DAYS = 30

# Captured from Mabangerp browser order list request. Runtime code only changes
# page / rowsPerPage / startTime1 / endTime1.
BASE_PAYLOAD_RAW = (
    "OrderPlus.isNewOrder=2&isSyncVal=&isSyncValIsVirtual=&isSyncLogisticsOrder=&"
    "isPackOrder=&isDeliverOrder=&isWaitPickupOrder=&isPendingOrder=&"
    "isOutOfStockOrder=&outOfStockOrderDay=&isSyncLogistics=&logisStatus=&"
    "isExpireOrder=&isWindControlOrder=&isShipmentOrderC=&isToDayOrder=&"
    "isToDayDeliveryOrder=&isResendOrderC=&isLogisticsRuleNotMatch=&"
    "noTrackOnlineDay=&quickPickType=&smtflag=&fbaFlag=&platformIdFbw=&"
    "shopeeAbnormal=&abnormalType=&cloudStatus=&isTuotou=&platformId=&"
    "leftSearchToWms=&getCompanyCloudStorageHtmlForJson=%5B%5D&"
    "supplierCompanyId_v=&orderBys%5B%5D=&postDta=&isshowordercombosku=2&"
    "title_Json=&platformTracknumberSearchInput=&platformTracknumberSearchtextarea=&"
    "orderSearchHistory=&OrderLogisticsSearch=&failureYiSearch=&view-hidden=&"
    "statusButton=&Order.orderStatus=&orderTypeButton=&labelMultipleChoiceWhere=cross&"
    "byField=1&startTime1=2026-04-28+10%3A56%3A52&endTime1=2026-05-28+10%3A56%3A52&"
    "OrderPlus.isTrackOnline=&OrderSearch.fuzzySearchKey=Order.platformOrderId&"
    "OrderSearchFuSKey=a.platformOrderId&daysOperator=%3D&OrderSearch.fuzzySearchValue=&"
    "startPageNum=&endPageNum=&orderPageKey=5e512831ff5b956a08a58fcf90d4dce6&"
    "goPaypalRefundStatus=1&page=1&rowsPerPage=100&Order_isCloud=2&m=order&"
    "a=orderalllist&isNewOrderPage=1&post_tableBase=1&showError=&pageListC=&"
    "jumpParams=undefined&1=1&tabId=222&"
    "global_company_config_json_str=eyJpZCI6IjE4NzU0OSIsIk1hcmtoYXNHb29kcyI6IjAiLCJleHRlbmRQYXJhbXMiOiJ7XCJ1blN5blBsYXRmb3JtcGx1czFcIjpcIjFcIixcImlzSW1tZWRpYXRlbHlwbHVzMVwiOlwiMVwiLFwiY2FsRmJhQXBwbHlcIjpcIjJcIixcIm9wZW5QaWNraW5nQWxlcnRcIjpcIjFcIixcImlzU2hvd1N0b2NrRGV0YWlsXCI6XCIyXCIsXCJkZWxpdmVyQ29udHJvbEFsZXJ0T3JkZXJcIjpcIjFcIixcInVuU3luUGxhdGZvcm1wbHVzUmVwZWF0XCI6XCIxXCIsXCJpc0ltbWVkaWF0ZWx5cGx1c1JlcGVhdFwiOlwiMVwifSIsImlzc2hvd29yZGVyY29tYm9za3UiOiIyIiwid21zY2hlY2tmbGFnIjoiMiIsInNtdFJlbWFpbmREYXlzIjoiMiIsInB1cmNoYXNlRGV0YWlsUmVtYXJrIjoiMiJ9&"
    "startPageNum=&endPageNum="
)


def connect_db():
    return pymysql.connect(**MYSQL_CONFIG)


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


def format_mabang_time(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")


def load_cookie() -> str:
    cookie = (os.getenv("MABANG_COOKIE") or "").strip()
    if not cookie:
        raise RuntimeError("Missing MABANG_COOKIE in .env")
    return cookie


def request_headers() -> Dict[str, str]:
    return {
        "accept": "application/json, text/javascript, */*; q=0.01",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "origin": "https://www.mabangerp.com",
        "referer": "https://www.mabangerp.com/index.php?mod=order.oTc",
        "user-agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
        ),
        "x-requested-with": "XMLHttpRequest",
        "cookie": load_cookie(),
    }


def base_payload() -> Dict[str, Any]:
    return dict(parse_qsl(BASE_PAYLOAD_RAW, keep_blank_values=True))


def build_payload(page: int, page_size: int, start_dt: datetime, end_dt: datetime) -> Dict[str, Any]:
    payload = base_payload()
    payload["page"] = str(page)
    payload["rowsPerPage"] = str(page_size)
    payload["startTime1"] = format_mabang_time(start_dt)
    payload["endTime1"] = format_mabang_time(end_dt)
    payload["m"] = "order"
    payload["a"] = "orderalllist"
    payload["OrderSearch.fuzzySearchKey"] = "Order.platformOrderId"
    payload["OrderSearchFuSKey"] = "a.platformOrderId"
    return payload


def parse_json_response(resp: requests.Response) -> Dict[str, Any]:
    text = resp.text or ""
    stripped = text.lstrip()
    if stripped.startswith("<"):
        raise requests.RequestException(
            f"Mabangerp returned HTML, cookie may be expired. final_url={resp.url} "
            f"body_prefix={text[:160]!r}"
        )
    try:
        data = resp.json()
    except ValueError:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise requests.RequestException(
                f"Mabangerp response is not JSON. status={resp.status_code} "
                f"ct={resp.headers.get('Content-Type')} body_prefix={text[:160]!r}"
            ) from e
    if not isinstance(data, dict):
        raise requests.RequestException(f"Mabangerp response JSON is {type(data).__name__}, expected object")
    return data


def extract_order_list(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = data.get("orderDataList")
    if isinstance(rows, list):
        return [row for row in rows if isinstance(row, dict)]
    for key in ("data", "result"):
        inner = data.get(key)
        if isinstance(inner, dict) and isinstance(inner.get("orderDataList"), list):
            return [row for row in inner["orderDataList"] if isinstance(row, dict)]
    return []


def fetch_page(
    session: requests.Session,
    page: int,
    page_size: int,
    start_dt: datetime,
    end_dt: datetime,
) -> List[Dict[str, Any]]:
    payload = build_payload(page, page_size, start_dt, end_dt)
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.post(API_URL, headers=request_headers(), data=payload, timeout=90)
            resp.raise_for_status()
            data = parse_json_response(resp)
            rows = extract_order_list(data)
            logger.info("page=%s fetched rows=%s", page, len(rows))
            return rows
        except requests.RequestException as e:
            logger.warning("page=%s request failed attempt=%s/%s: %s", page, attempt, MAX_RETRIES, e)
            if attempt >= MAX_RETRIES:
                raise
            time.sleep(2)
    return []


def safe_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_black_state(value: Any) -> Optional[int]:
    text = safe_str(value)
    if text == "1":
        return 1
    if text == "2":
        return 0
    return None


def iter_order_pairs(rows: Iterable[Dict[str, Any]]) -> Iterable[Tuple[str, int, Dict[str, Any]]]:
    for row in rows:
        order_id = safe_str(row.get("platformOrderId"))
        black_state = normalize_black_state(row.get("isBlackUser"))
        if order_id and black_state is not None:
            yield order_id, black_state, row


def apply_black_state(cursor, order_id: str, black_state: int, dry_run: bool) -> str:
    cursor.execute("SELECT COUNT(1) FROM orders WHERE BINARY order_id = BINARY %s", (order_id,))
    exists = bool(cursor.fetchone()[0])
    if not exists:
        return "unmatched"
    if dry_run:
        return "dry_run_update"
    cursor.execute("UPDATE orders SET black_state = %s WHERE BINARY order_id = BINARY %s", (black_state, order_id))
    return "updated"


def add_stat(stats: Dict[str, int], key: str, value: int = 1) -> None:
    stats[key] = stats.get(key, 0) + value


def parse_args():
    parser = argparse.ArgumentParser(description="Sync orders.black_state from Mabangerp order list")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and match, but do not update DB")
    parser.add_argument("--since-days", type=int, default=None, help="Fetch orders in the last N days")
    parser.add_argument("--start-date", default=None, help="Fetch orders created at/after this date or datetime")
    parser.add_argument("--end-date", default=None, help="Fetch orders created at/before this date or datetime")
    parser.add_argument("--max-pages", type=int, default=None, help="Stop after N pages")
    parser.add_argument("--limit", type=int, default=None, help="Stop after processing N valid Mabangerp rows")
    parser.add_argument("--debug-fetch", action="store_true", help="Print extracted values for fetched rows")
    parser.add_argument("--debug-fetch-max", type=int, default=20, help="Max debug rows, -1 for unlimited")
    return parser.parse_args()


def resolve_time_range(args) -> Tuple[datetime, datetime]:
    end_dt = parse_datetime_arg(args.end_date, end_of_day=True) or datetime.now()
    if args.since_days is not None:
        if args.since_days < 0:
            raise ValueError("--since-days must be >= 0")
        start_dt = datetime.now() - timedelta(days=args.since_days)
    else:
        start_dt = end_dt - timedelta(days=DEFAULT_LOOKBACK_DAYS)
    explicit_start = parse_datetime_arg(args.start_date)
    if explicit_start:
        start_dt = explicit_start
    if start_dt > end_dt:
        raise ValueError("start date is later than end date")
    return start_dt, end_dt


def main() -> None:
    args = parse_args()
    if args.debug_fetch_max < 0:
        args.debug_fetch_max = -1
    start_dt, end_dt = resolve_time_range(args)
    logger.info("Mabangerp time filter: start=%s end=%s", start_dt, end_dt)

    stats: Dict[str, int] = {}
    debug_budget = args.debug_fetch_max
    seen_order_ids: set[str] = set()

    session = requests.Session()
    conn = connect_db()
    try:
        with conn.cursor() as cursor:
            page = 1
            while True:
                if args.max_pages is not None and page > args.max_pages:
                    break
                rows = fetch_page(session, page, PAGE_SIZE, start_dt, end_dt)
                add_stat(stats, "pages")
                add_stat(stats, "api_rows", len(rows))
                if not rows:
                    break

                for row in rows:
                    order_id = safe_str(row.get("platformOrderId"))
                    raw_black = row.get("isBlackUser")
                    black_state = normalize_black_state(raw_black)
                    if not order_id:
                        add_stat(stats, "skipped_empty_platform_order_id")
                        continue
                    if black_state is None:
                        add_stat(stats, "unknown_is_black_user")
                        continue
                    if order_id in seen_order_ids:
                        add_stat(stats, "duplicate_platform_order_id")
                    seen_order_ids.add(order_id)

                    if black_state == 1:
                        add_stat(stats, "black_rows")
                    else:
                        add_stat(stats, "white_rows")

                    if args.debug_fetch and debug_budget != 0:
                        logger.info(
                            "[debug-fetch] %s",
                            json.dumps(
                                {
                                    "platformOrderId": order_id,
                                    "isBlackUser": raw_black,
                                    "black_state": black_state,
                                    "keys_sample": sorted(str(k) for k in row.keys())[:80],
                                },
                                ensure_ascii=False,
                                default=str,
                            ),
                        )
                        if debug_budget > 0:
                            debug_budget -= 1

                    status = apply_black_state(cursor, order_id, black_state, args.dry_run)
                    add_stat(stats, status)
                    if status in ("updated", "dry_run_update"):
                        add_stat(stats, "updated_to_black" if black_state == 1 else "updated_to_white")
                    add_stat(stats, "valid_rows")

                    if args.limit is not None and stats.get("valid_rows", 0) >= args.limit:
                        break

                if args.limit is not None and stats.get("valid_rows", 0) >= args.limit:
                    break
                if len(rows) < PAGE_SIZE:
                    break
                page += 1
                time.sleep(REQUEST_INTERVAL)

            if args.dry_run:
                conn.rollback()
            else:
                conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
        session.close()

    logger.info("Done: %s", json.dumps(stats, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
