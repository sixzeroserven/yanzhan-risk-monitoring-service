"""
脚本用途: 用于定时更新Hipay交易号到数据库（新轮询）

从 Hipay PayOrder 列表分页拉取全部数据：rows 里每条为对象，取 orderAid、orderCid，
按 orderAid 更新 orders.order_id 对应的 transaction_id（orderCid）。未匹配则跳过、不插新行。
配置与 jobs/crawl_orders.py 一样：库表用 .env 的 DB_*；Hipay 鉴权使用环境变量 HIPAY_AUTHORIZATION（完整 Bearer 串，见 .env.example）。

用法：
  python3 jobs/sync_hipay_transaction_ids.py
  python3 jobs/sync_hipay_transaction_ids.py --dry-run
"""
import argparse
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import pymysql
import requests
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# ======================== 配置区域 ========================
MYSQL_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", 3306)),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", ""),
    "charset": "utf8mb4",
}

LIST_URL = "https://hipay.top/prod-api/system/PayOrder/list"
PAGE_SIZE = 100
PAY_TYPE = 2


def hipay_request_headers() -> Dict[str, str]:
    """Authorization 来自环境变量 HIPAY_AUTHORIZATION（与浏览器里一致，含 Bearer 前缀）。"""
    raw = os.getenv("HIPAY_AUTHORIZATION", "").strip()
    if not raw:
        logger.error("请配置环境变量 HIPAY_AUTHORIZATION（可在项目根目录 .env 中设置）")
        raise SystemExit(1)
    if not raw.lower().startswith("bearer"):
        raw = f"Bearer {raw}"
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "authorization": raw,
        "referer": "https://hipay.top/pay/PayOrder",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    }


def ensure_transaction_id_column(cursor) -> None:
    db_name = MYSQL_CONFIG["database"]
    cursor.execute(
        """
        SELECT COUNT(1) FROM information_schema.columns
        WHERE table_schema = %s AND table_name = 'orders' AND column_name = 'transaction_id'
        """,
        (db_name,),
    )
    if cursor.fetchone()[0] == 0:
        cursor.execute(
            "ALTER TABLE orders ADD COLUMN transaction_id VARCHAR(100) DEFAULT NULL "
            "COMMENT '交易号/orderCid' AFTER order_id"
        )
        logger.info("已为 orders 表新增 transaction_id 字段")


def pick_str(row: Dict[str, Any], *keys: str) -> str:
    for k in keys:
        if k in row and row[k] is not None:
            s = str(row[k]).strip()
            if s:
                return s
    return ""


def extract_list_payload(data: Dict[str, Any]) -> Tuple[List[Any], Optional[int]]:
    total = data.get("total")
    rows = data.get("rows")
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        rows = []
    try:
        total_int = int(total) if total is not None else None
    except (TypeError, ValueError):
        total_int = None
    return rows, total_int


def fetch_page(session: requests.Session, page_num: int, headers: Dict[str, str]) -> Dict[str, Any]:
    params = {"pageNum": page_num, "pageSize": PAGE_SIZE, "payType": PAY_TYPE}
    resp = session.get(LIST_URL, params=params, headers=headers, timeout=60)
    resp.raise_for_status()
    return resp.json()


def sync_from_hipay(dry_run: bool) -> Dict[str, int]:
    req_headers = hipay_request_headers()
    auth = (req_headers.get("authorization") or "").strip()
    token_part = auth[7:].strip() if auth.lower().startswith("bearer") else auth
    if not token_part:
        logger.error("HIPAY_AUTHORIZATION 无效")
        raise SystemExit(1)

    stats = {
        "pages": 0,
        "api_rows": 0,
        "skipped_not_dict": 0,
        "empty_order_aid": 0,
        "empty_order_cid": 0,
        "db_updated": 0,
        "db_no_match": 0,
    }

    session = requests.Session()
    page_num = 1
    total_expected: Optional[int] = None
    fetched_total = 0
    pairs: List[Tuple[str, str]] = []

    while True:
        raw = fetch_page(session, page_num, req_headers)
        code = raw.get("code")
        if code not in (200, 0, None):
            logger.warning("接口 code=%s msg=%s", code, raw.get("msg") or raw.get("message"))

        rows, page_total = extract_list_payload(raw)
        if total_expected is None and page_total is not None:
            total_expected = page_total

        stats["pages"] += 1
        if not rows:
            logger.info("第 %s 页无数据，结束分页", page_num)
            break

        for row in rows:
            if not isinstance(row, dict):
                stats["skipped_not_dict"] += 1
                continue
            order_aid = pick_str(row, "orderAid", "order_aid", "orderAID")
            order_cid = pick_str(row, "orderCid", "order_cid", "orderCID")
            stats["api_rows"] += 1
            if not order_aid:
                stats["empty_order_aid"] += 1
                continue
            if not order_cid:
                stats["empty_order_cid"] += 1
            pairs.append((order_aid, order_cid))

        fetched_total += len(rows)
        logger.info(
            "第 %s 页：本页 %s 条，累计 %s 条，接口 total=%s",
            page_num,
            len(rows),
            fetched_total,
            total_expected if total_expected is not None else "?",
        )

        if total_expected is not None and fetched_total >= total_expected:
            break
        if len(rows) < PAGE_SIZE:
            break

        page_num += 1
        time.sleep(0.2)

    merged: Dict[str, str] = {}
    for order_aid, order_cid in pairs:
        merged[order_aid] = order_cid

    if dry_run:
        logger.info(
            "[dry-run] 行=%s，去重后 orderAid=%s，非对象行=%s",
            stats["api_rows"],
            len(merged),
            stats["skipped_not_dict"],
        )
        return stats

    conn = pymysql.connect(**MYSQL_CONFIG)
    cursor = conn.cursor()
    try:
        ensure_transaction_id_column(cursor)
        conn.commit()

        update_sql = "UPDATE orders SET transaction_id = %s WHERE order_id = %s"
        for order_aid, order_cid in merged.items():
            if not order_cid:
                continue
            if len(order_cid) > 100:
                logger.warning("orderCid 超长已截断：orderAid=%s len=%s", order_aid, len(order_cid))
                order_cid = order_cid[:100]
            cursor.execute(update_sql, (order_cid, order_aid))
            if cursor.rowcount > 0:
                stats["db_updated"] += cursor.rowcount
            else:
                stats["db_no_match"] += 1

        conn.commit()
    finally:
        cursor.close()
        conn.close()

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Hipay orderCid -> orders.transaction_id")
    parser.add_argument("--dry-run", action="store_true", help="只拉接口不写库")
    args = parser.parse_args()

    if not MYSQL_CONFIG["database"] and not args.dry_run:
        logger.error("请配置 DB_NAME")
        raise SystemExit(1)

    stats = sync_from_hipay(dry_run=args.dry_run)
    logger.info(
        "完成：pages=%s api_rows=%s skipped_not_dict=%s empty_order_aid=%s empty_order_cid=%s "
        "db_updated=%s db_no_match=%s dry_run=%s",
        stats["pages"],
        stats["api_rows"],
        stats["skipped_not_dict"],
        stats["empty_order_aid"],
        stats["empty_order_cid"],
        stats["db_updated"],
        stats["db_no_match"],
        args.dry_run,
    )


if __name__ == "__main__":
    main()
