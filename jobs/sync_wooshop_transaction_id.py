"""
脚本用途: 用于一次性导入旧轮询系统的交易号到数据库


从 API (WooShop PaaS) 分页获取支付订单；每条必须有 order_number（或兼容字段）。
pay_transaction_id 可选：模糊匹配到唯一本地 order_id 时，有交易号则写入 transaction_id，没有则置 NULL。

按 API 的订单号对 orders.order_id 做模糊匹配（LIKE '%order_number%'）。
命中多行时先对 order_id 去重：若实际只有一个不同的 order_id，则更新该订单；
若存在多个不同的 order_id 则跳过（歧义）。

接口信息：
  URL: https://api.wooshoppaas.shop/manage/ok-safe-pay/order-lists
  Method: POST
  Headers: Authorization, Content-Type: application/json
  Request Body: 见下方 build_order_list_payload（与前端一致：page、page_size 等）
  Response: { "data": { "count": 41978, "list": [...] } }

用法：
  python3 jobs/sync_wooshop_transaction_id.py
  python3 jobs/sync_wooshop_transaction_id.py --dry-run

分页若无效（每页订单号集合与上一页完全相同），脚本会中止。筛选条件可在 build_order_list_payload 内改，不写 env。
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

API_URL = "https://api.wooshoppaas.shop/manage/ok-safe-pay/order-lists"
HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    "authorization": "mgu122_67a0d51300dd9f8fe9c5948aa2437fc66ae7ca43",
    "content-type": "application/json",
    "origin": "https://manage.wooshoppaas.shop",
    "referer": "https://manage.wooshoppaas.shop/",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
}
# 如果接口需要 Shopid 请求头，取消下面注释并填入正确的值
# HEADERS["Shopid"] = "your_shop_id"

PAGE_SIZE = 20
PAGE_START = 1


def build_order_list_payload(page: int) -> Dict[str, Any]:
    """
    POST Body 与前端一致；仅 page / page_size 随分页变化，其余筛选在本函数内改。
    示例：{"page":1,"page_size":20,"shop_a_id":"","shop_b_id":"","receive_account":"","create_start":"","create_end":"","order_number":"","transaction_id":""}
    """
    return {
        "page": page,
        "page_size": PAGE_SIZE,
        "shop_a_id": "",
        "shop_b_id": "",
        "receive_account": "",
        "create_start": "",
        "create_end": "",
        "order_number": "",
        "transaction_id": "",
    }


# 响应数据路径：例如 data.list 和 data.count
DATA_PATH = ["data", "list"]
COUNT_PATH = ["data", "count"]

REQUEST_INTERVAL = 0.5
MAX_RETRIES = 3
# 数据库阶段：每处理多少条打一条进度日志（避免几万条期间控制台长时间无输出）
DB_PROGRESS_EVERY = 500
# ================================================================


def ensure_transaction_id_column(cursor) -> None:
    """确保 orders 表有 transaction_id 字段"""
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
            "COMMENT '交易号' AFTER order_id"
        )
        logger.info("已为 orders 表新增 transaction_id 字段")


def extract_order_number(row: Dict[str, Any]) -> Optional[str]:
    for key in ("order_number", "orderNumber", "order_no", "orderNo"):
        v = row.get(key)
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def extract_pay_transaction_id(row: Dict[str, Any]) -> Optional[str]:
    """有值则返回字符串（过长会截断）；接口缺字段或为空则返回 None，对应数据库写入 NULL。"""
    for key in ("pay_transaction_id", "payTransactionId", "transaction_id", "payTxnId"):
        v = row.get(key)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s[:100] if len(s) > 100 else s
    return None


def get_nested_value(data: Any, path: List[str]) -> Any:
    """根据路径列表获取嵌套字典中的值"""
    for key in path:
        if isinstance(data, dict):
            data = data.get(key)
        else:
            return None
    return data


def fetch_page(session: requests.Session, page_num: int) -> Tuple[List[Dict], int]:
    """
    请求一页数据，返回 (记录列表, 总记录数)
    如果请求失败或格式错误，返回 ([], 0)
    """
    payload = build_order_list_payload(page_num)
    logger.debug("POST %s body=%s", API_URL, payload)

    for attempt in range(MAX_RETRIES):
        try:
            resp = session.post(API_URL, headers=HEADERS, json=payload, timeout=30)
            resp.raise_for_status()
            data = resp.json()

            # 检查接口是否返回错误（例如 code != 0）
            if "code" in data and data.get("code") not in (0, 200):
                logger.warning(f"第 {page_num} 页接口返回错误码: {data.get('code')}, msg: {data.get('msg')}")
                # 如果是认证失败，不再重试
                if data.get("code") in (401, 403):
                    return [], 0

            rows = get_nested_value(data, DATA_PATH)
            if not isinstance(rows, list):
                rows = []
            total = get_nested_value(data, COUNT_PATH)
            if total is None:
                total = 0
            else:
                try:
                    total = int(total)
                except (TypeError, ValueError):
                    total = 0
            logger.debug(f"第 {page_num} 页获取 {len(rows)} 条，总数 {total}")
            return rows, total
        except Exception as e:
            logger.warning(f"第 {page_num} 页请求失败 (尝试 {attempt+1}/{MAX_RETRIES}): {e}")
            if attempt == MAX_RETRIES - 1:
                return [], 0
            time.sleep(2 ** attempt)  # 指数退避
    return [], 0


def _page_order_keys(rows: List[Any]) -> Tuple[str, ...]:
    keys: List[str] = []
    for row in rows:
        if isinstance(row, dict):
            oid = extract_order_number(row)
            if oid:
                keys.append(oid)
    keys.sort()
    return tuple(keys)


def fetch_all_orders(session: requests.Session) -> Dict[str, Optional[str]]:
    """
    全量抓取所有页面，返回 {api订单号: 交易号或 None}（同一订单号后者覆盖前者）。
    交易号为 None 表示后续将把匹配到的 order.transaction_id 更新为 NULL。
    """
    pairs: Dict[str, Optional[str]] = {}
    page_num = PAGE_START
    total_expected = None
    fetched_total = 0
    cumulative_with_order = 0
    cumulative_with_txn = 0
    prev_page_keys: Optional[Tuple[str, ...]] = None
    duplicate_pages_stopped = False

    while True:
        rows, total = fetch_page(session, page_num)
        if total_expected is None and total > 0:
            total_expected = total
            logger.info(f"总记录数: {total_expected}")

        if not rows:
            if page_num == PAGE_START:
                logger.warning("第一页无数据，请检查接口或认证")
            else:
                logger.info(f"第 {page_num} 页无数据，结束抓取")
            break

        if isinstance(rows[0], dict):
            logger.debug("首条记录字段名: %s", list(rows[0].keys()))

        page_keys = _page_order_keys(rows)
        if prev_page_keys is not None and page_keys == prev_page_keys and len(page_keys) > 0:
            logger.error(
                "第 %s 页与上一页的「订单号集合」完全一致，分页未生效（可能仍返回第一页）。"
                "请核对 build_order_list_payload 里的字段名是否与接口一致（page / page_size / 首页从 0 还是 1）。已中止抓取。",
                page_num,
            )
            duplicate_pages_stopped = True
            break
        prev_page_keys = page_keys

        page_order = 0
        page_txn = 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            oid = extract_order_number(row)
            if not oid:
                continue
            page_order += 1
            cumulative_with_order += 1
            txn = extract_pay_transaction_id(row)
            if txn:
                page_txn += 1
                cumulative_with_txn += 1
            pairs[oid] = txn

        fetched_total += len(rows)
        logger.info(
            f"第 {page_num} 页：本页 {len(rows)} 条，含订单号 {page_order} 条（其中含交易号 {page_txn}）；"
            f"累计含订单号行 {cumulative_with_order}，累计含交易号行 {cumulative_with_txn}；"
            f"去重 API 订单号 {len(pairs)} 个（跨页累计的唯一订单号；分页正常时应持续增大）；"
            f"抓取进度 {fetched_total}/{total_expected if total_expected else '?'}"
        )

        # 判断是否已抓完所有数据（基于 total）；若分页无效勿依赖此项（会因重复页永远达不到 total）
        if total_expected is not None and fetched_total >= total_expected and not duplicate_pages_stopped:
            logger.info("已达到总记录数，抓取完成")
            break

        # 继续下一页
        page_num += 1
        time.sleep(REQUEST_INTERVAL)

    logger.info(
        f"抓取完成：累计含订单号行 {cumulative_with_order}，累计含交易号行 {cumulative_with_txn}，"
        f"去重后待处理 API 订单号 {len(pairs)} 个"
        + ("（已因分页重复提前中止）" if duplicate_pages_stopped else "")
    )
    return pairs


def update_database(pairs: Dict[str, Optional[str]], dry_run: bool) -> Dict[str, int]:
    """
    模糊匹配 orders.order_id；对命中行的 order_id 去重后仅一个则更新（重复行视为一行）。
    txn 有值则写入 transaction_id，txn 为 None 则置 NULL。
    """
    stats = {"db_updated": 0, "db_no_match": 0, "db_ambiguous": 0}

    total = len(pairs)
    if dry_run:
        logger.info(f"[dry-run] 将尝试模糊匹配 {total} 个订单号")
        return stats

    logger.info(
        "开始数据库模糊匹配：共 %s 个 API 订单号（每条约 2 次 SQL，耗时会较长；每 %s 条输出一次进度）",
        total,
        DB_PROGRESS_EVERY,
    )

    conn = pymysql.connect(**MYSQL_CONFIG)
    cursor = conn.cursor()
    try:
        ensure_transaction_id_column(cursor)
        conn.commit()

        sql_find = "SELECT order_id FROM orders WHERE order_id LIKE %s"
        sql_update = "UPDATE orders SET transaction_id = %s WHERE order_id = %s"

        for idx, (order_number, txn) in enumerate(pairs.items(), start=1):
            # 模糊匹配模式: %order_number%
            pattern = f"%{order_number}%"
            cursor.execute(sql_find, (pattern,))
            results = cursor.fetchall()
            unique_order_ids = list(dict.fromkeys(row[0] for row in results))

            if len(unique_order_ids) == 0:
                stats["db_no_match"] += 1
                logger.debug(f"未匹配: order_number={order_number}")
            elif len(unique_order_ids) == 1:
                matched_order_id = unique_order_ids[0]
                tid: Optional[str]
                if txn is None:
                    tid = None
                else:
                    tid = txn[:100] if len(txn) > 100 else txn
                    if len(txn) > 100:
                        logger.warning(f"交易号超长已截断：order_number={order_number} len={len(txn)}")
                cursor.execute(sql_update, (tid, matched_order_id))
                if cursor.rowcount > 0:
                    stats["db_updated"] += 1
                if tid is None:
                    logger.debug(f"更新成功(交易号置空): order_number={order_number} -> order_id={matched_order_id}")
                else:
                    logger.debug(f"更新成功: order_number={order_number} -> order_id={matched_order_id}")
            else:
                stats["db_ambiguous"] += 1
                logger.warning(
                    f"模糊匹配到多个不同 order_id，跳过更新: order_number={order_number}, "
                    f"unique_order_ids={unique_order_ids}"
                )

            if idx % DB_PROGRESS_EVERY == 0 or idx == total:
                logger.info(
                    "匹配进度 %s/%s：db_updated=%s db_no_match=%s db_ambiguous=%s",
                    idx,
                    total,
                    stats["db_updated"],
                    stats["db_no_match"],
                    stats["db_ambiguous"],
                )

        conn.commit()
    finally:
        cursor.close()
        conn.close()

    return stats


def main():
    parser = argparse.ArgumentParser(description="从 WooShop API 同步交易号到 orders.transaction_id（模糊匹配）")
    parser.add_argument("--dry-run", action="store_true", help="只拉取接口，不写数据库")
    args = parser.parse_args()

    if not MYSQL_CONFIG["database"] and not args.dry_run:
        logger.error("请配置 DB_NAME")
        raise SystemExit(1)

    session = requests.Session()
    pairs = fetch_all_orders(session)
    if not pairs:
        logger.warning("未获取到任何带订单号的接口数据")
        return

    logger.info("接口抓取阶段结束，进入数据库写入阶段…")
    stats = update_database(pairs, dry_run=args.dry_run)
    logger.info(
        f"完成：unique_pairs={len(pairs)} db_updated={stats['db_updated']} "
        f"db_no_match={stats['db_no_match']} db_ambiguous={stats['db_ambiguous']} dry_run={args.dry_run}"
    )


if __name__ == "__main__":
    main()