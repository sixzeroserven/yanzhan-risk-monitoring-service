"""
抓取店小秘订单（含黑名单标识）并存入 MySQL
支持两种模式：
  - full : 全量历史数据（history=all）
  - recent : 最近120天内的数据（history= 空）
通过环境变量 FETCH_MODE 或命令行参数 --mode 指定，默认为 recent
"""
from datetime import datetime
from dotenv import load_dotenv
import os
import requests
import pymysql
import logging
import time
import argparse
from typing import List, Dict, Any, Tuple, Set, Optional

load_dotenv()

# ======================== 配置区域 ========================
MYSQL_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'port': int(os.getenv('DB_PORT', 3306)),
    'user': os.getenv('DB_USER', 'root'),
    'password': os.getenv('DB_PASSWORD', ''),
    'database': os.getenv('DB_NAME', ''),
    'charset': 'utf8mb4'
}

API_URL = "https://www.dianxiaomi.com/api/package/advancedSearch.json"


def dianxiaomi_request_headers() -> Dict[str, Any]:
    """Cookie 来自环境变量 DIANXIAOMI_COOKIE（与浏览器里请求一致，需定期更新）。"""
    cookie = os.getenv("DIANXIAOMI_COOKIE", "").strip()
    if not cookie:
        logger.error("请配置环境变量 DIANXIAOMI_COOKIE（可在项目根目录 .env 中设置）")
        raise SystemExit(1)
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9",
        "content-type": "application/x-www-form-urlencoded",
        "origin": "https://www.dianxiaomi.com",
        "referer": "https://www.dianxiaomi.com/web/order/all?go=m1-1",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "bx-v": "2.5.11",
        "cookie": cookie,
    }

# POST 请求体公共部分
BASE_PAYLOAD = {
    "searchTypes": "orderId",
    "contents": "",
    "orderAdvSearchType": 1,
    "state": "",
    "isVoided": -1,
    "isRemoved": -1,
    "commitPlatforms": "",
    "isOversea": -1,
    "shopId": -1,
    "platform": "",
    # history 字段会在 build_payload_for_mode 中动态设置
    "orderField": "order_create_time",
    "isDesc": 1,
    "timeOut": 0,
    "warehouseCode": "",
    "isGreen": 0,
    "isYellow": 0,
    "isOrange": 0,
    "isRed": 0,
    "isViolet": 0,
    "isBlue": 0,
    "cornflowerBlue": 0,
    "pink": 0,
    "teal": 0,
    "turquoise": 0,
    "unmarked": 0,
    "forbiddenStatus": -1,
    "forbiddenReason": 0,
    "pickingInstructions": "",
    "priceStart": "",
    "priceEnd": "",
    "orderCreateStart": "",
    "orderCreateEnd": "",
    "orderPayStart": "",
    "orderPayEnd": "",
    "applyTimeStart": "",
    "applyTimeEnd": "",
    "shippedStart": "",
    "shippedEnd": "",
    "refundedStart": "",
    "refundedEnd": "",
    "mdSignStart": "",
    "mdSignEnd": "",
    "jhSignStart": "",
    "jhSignEnd": "",
    "timeOutQuery": -1,
    "productCountStart": "",
    "productCountEnd": "",
    "storageIds": "",
    "storageId": 0,
    "authId": -1,
    "days": -1,
    "country": "",
    "isPrintJh": -1,
    "isPrintJhTemp": -1,
    "signPriorShip": -1,
    "isPrintMd": -1,
    "commitPlatform": "",
    "isHasOrderMessage": -1,
    "isHasOrderComment": -1,
    "isHasServiceComment": -1,
    "isHasPickComment": -1,
    "globalCollection": -1,
    "platformOrderStatus": "",
}

PAGE_SIZE = 200
REQUEST_INTERVAL = 0.5
MAX_RETRIES = 3

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# ======================== 数据库初始化 ========================
def init_database():
    """创建两张表（如果不存在）"""
    conn = pymysql.connect(**MYSQL_CONFIG)
    cursor = conn.cursor()

    create_orders_sql = """
    CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
        order_id VARCHAR(100) NOT NULL COMMENT '原始订单号',
        package_number VARCHAR(100) NOT NULL COMMENT '包裹号',
        buyer_name VARCHAR(200) COMMENT '买家姓名',
        contact_name VARCHAR(200) COMMENT '联系人姓名',
        buyer_account VARCHAR(200) COMMENT '买家账号',
        buyer_country VARCHAR(10) COMMENT '买家国家代码',
        black_state TINYINT(1) NOT NULL DEFAULT 0 COMMENT '黑名单状态: 0-非黑名单, 1-黑名单',
        order_state VARCHAR(64) COMMENT '店小秘 orderState',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_order_id (order_id),
        INDEX idx_package_number (package_number),
        UNIQUE KEY uk_order_package (order_id, package_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    cursor.execute(create_orders_sql)
    ensure_order_state_column(cursor)

    create_address_sql = """
    CREATE TABLE IF NOT EXISTS order_address (
        addr_id INT AUTO_INCREMENT PRIMARY KEY COMMENT '地址自增主键',
        source_id VARCHAR(50) COMMENT '接口返回的地址记录ID（原id字段）',
        order_id VARCHAR(100) NOT NULL COMMENT '关联订单号',
        phone_number VARCHAR(50),
        country VARCHAR(10),
        province VARCHAR(100),
        city VARCHAR(100),
        district VARCHAR(100),
        contact_person VARCHAR(200),
        mobile VARCHAR(50),
        detail_address TEXT,
        address2 VARCHAR(200),
        email VARCHAR(200),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_order_id (order_id),
        INDEX idx_phone (phone_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    cursor.execute(create_address_sql)

    conn.commit()
    cursor.close()
    conn.close()
    logger.info("数据库表初始化完成")


def extract_order_state(order_item: Dict[str, Any]) -> Optional[str]:
    """店小秘接口 orderState 字段，存库为 order_state。"""
    val = order_item.get("orderState")
    if val is None:
        return None
    text = str(val).strip()
    return text if text else None


def ensure_order_state_column(cursor) -> None:
    cursor.execute(
        """
        SELECT COUNT(1) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'order_state'
        """
    )
    if cursor.fetchone()[0] == 0:
        cursor.execute(
            "ALTER TABLE orders ADD COLUMN order_state VARCHAR(64) DEFAULT NULL "
            "COMMENT '店小秘 orderState' AFTER black_state"
        )
        logger.info("已为 orders 表新增 order_state 字段")


# ======================== 保存单个订单（含地址及子订单） ========================
def save_single_order(order_item: Dict[str, Any], fallback_addr: Optional[Dict[str, Any]] = None, forced_black_state: Optional[int] = None) -> bool:
    """
    保存单个订单记录（主表）及其地址。
    如果订单自身有地址则使用自身地址，否则使用 fallback_addr（如父订单地址）。
    forced_black_state: 若传入（0或1），则强制使用该值作为黑名单状态，忽略订单自身的 blackState。
    返回 True 表示至少订单主表插入成功（或已存在），False 表示订单主表插入失败。
    """
    conn = pymysql.connect(**MYSQL_CONFIG)
    cursor = conn.cursor()
    order_id = order_item.get('orderId')
    package_number = order_item.get('packageNumber')

    if not order_id or not package_number:
        logger.warning(f"跳过无效订单: orderId={order_id}, packageNumber={package_number}")
        return False

    # 确定黑名单状态
    if forced_black_state is not None:
        black_state = 1 if forced_black_state else 0
    else:
        black_state = order_item.get('blackState', 0)
        if black_state not in (0, 1):
            black_state = 0

    try:
        # 订单主表：插入或更新
        order_sql = """
        INSERT INTO orders (order_id, package_number, buyer_name, contact_name, buyer_account, buyer_country, black_state, order_state)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON DUPLICATE KEY UPDATE
            buyer_name = VALUES(buyer_name),
            contact_name = VALUES(contact_name),
            buyer_account = VALUES(buyer_account),
            buyer_country = VALUES(buyer_country),
            black_state = VALUES(black_state),
            order_state = VALUES(order_state)
        """
        order_values = (
            order_id,
            package_number,
            order_item.get('buyerName'),
            order_item.get('contactName'),
            order_item.get('buyerAccount'),
            order_item.get('buyerCountry'),
            black_state,
            extract_order_state(order_item),
        )
        cursor.execute(order_sql, order_values)
        conn.commit()

        # 地址表：优先使用订单自身的地址，否则使用 fallback_addr
        addr = order_item.get('dxmPackageAddr')
        if not addr and fallback_addr:
            addr = fallback_addr

        if addr and isinstance(addr, dict):
            addr_sql = """
            INSERT INTO order_address (
                source_id, order_id, phone_number, country, province, city, district,
                contact_person, mobile, detail_address, address2, email
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                source_id = VALUES(source_id),
                phone_number = VALUES(phone_number),
                country = VALUES(country),
                province = VALUES(province),
                city = VALUES(city),
                district = VALUES(district),
                contact_person = VALUES(contact_person),
                mobile = VALUES(mobile),
                detail_address = VALUES(detail_address),
                address2 = VALUES(address2),
                email = VALUES(email)
            """
            addr_values = (
                addr.get('id'),
                order_id,
                addr.get('phoneNumber'),
                addr.get('country'),
                addr.get('province'),
                addr.get('city'),
                addr.get('district'),
                addr.get('contactPerson'),
                addr.get('mobile'),
                addr.get('detailAddress'),
                addr.get('address2'),
                addr.get('email')
            )
            cursor.execute(addr_sql, addr_values)
            conn.commit()
        else:
            if fallback_addr is None:
                logger.warning(f"订单 {order_id} 既无自身地址也无备选地址，地址未保存")
        return True
    except Exception as e:
        logger.error(f"保存订单 {order_id} 时发生异常: {e}")
        conn.rollback()
        return False
    finally:
        cursor.close()
        conn.close()


def save_order_with_subs(order_item: Dict[str, Any], fallback_addr: Optional[Dict[str, Any]] = None, parent_black_state: Optional[int] = None):
    """
    递归保存一个订单及其所有子订单。
    如果当前订单有自身地址，则将该地址作为子订单的备选地址；
    否则继续传递上层传入的 fallback_addr。
    黑名单继承规则：如果父订单（上层）是黑名单（parent_black_state=1），则当前订单强制为黑名单；
    否则使用当前订单自身的 blackState。
    """
    # 确定当前订单的黑名单状态（优先继承父订单的黑名单）
    if parent_black_state == 1:
        current_black_state = 1
    else:
        current_black_state = order_item.get('blackState', 0)
        if current_black_state not in (0, 1):
            current_black_state = 0

    # 确定要传递给子订单的备选地址
    current_addr = order_item.get('dxmPackageAddr')
    addr_to_pass = current_addr if current_addr else fallback_addr

    # 保存当前订单（强制使用计算出的黑名单状态）
    save_single_order(order_item, fallback_addr=fallback_addr, forced_black_state=current_black_state)

    # 处理子订单，传递当前订单的黑名单状态（用于继承）
    sub_orders = order_item.get('subOrderList')
    if sub_orders and isinstance(sub_orders, list):
        logger.debug(f"订单 {order_item.get('orderId')} 包含 {len(sub_orders)} 个子订单，开始处理")
        for sub_order in sub_orders:
            save_order_with_subs(sub_order, fallback_addr=addr_to_pass, parent_black_state=current_black_state)


def save_orders_batch(orders: List[Dict[str, Any]]):
    """批量保存订单（含子订单）"""
    total_processed = 0
    for order in orders:
        save_order_with_subs(order, fallback_addr=None, parent_black_state=None)
        total_processed += 1
    logger.info(f"批量保存完成：处理了 {total_processed} 个顶层订单（每个顶层订单可能附带多个子订单）")


# ======================== 网络请求（支持动态payload） ========================
def fetch_orders_page(page_no: int, payload_template: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], int, int]:
    """根据给定的 payload 模板（已包含时间范围等参数）请求一页数据"""
    payload = payload_template.copy()
    payload['pageNo'] = page_no
    payload['pageSize'] = PAGE_SIZE

    for attempt in range(MAX_RETRIES):
        try:
            resp = requests.post(API_URL, headers=dianxiaomi_request_headers(), data=payload, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if data.get('code') != 0:
                raise Exception(f"接口返回错误码 {data.get('code')}: {data.get('msg')}")
            page_data = data.get('data', {}).get('page', {})
            order_list = page_data.get('list', [])
            total_size = page_data.get('totalSize', 0)
            total_page = page_data.get('totalPage', 0)
            logger.info(f"第 {page_no} 页请求成功，获取 {len(order_list)} 条订单，总记录数 {total_size}，总页数 {total_page}")
            return order_list, total_size, total_page
        except Exception as e:
            logger.warning(f"第 {page_no} 页请求失败 (尝试 {attempt+1}/{MAX_RETRIES}): {e}")
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(2)
    return [], 0, 0


def fetch_all_orders(payload_template: Dict[str, Any]) -> List[Dict[str, Any]]:
    """根据 payload_template 循环获取所有页的订单，并基于 (order_id, package_number) 去重"""
    all_orders = []
    seen_combinations: Set[Tuple[str, str]] = set()

    try:
        first_orders, total_size, total_page = fetch_orders_page(1, payload_template)
    except Exception as e:
        logger.error(f"获取第一页失败: {e}，停止抓取")
        return []

    if total_page == 0:
        logger.warning("接口返回 totalPage = 0，可能无数据或参数错误")
        return []

    logger.info(f"共需抓取 {total_page} 页，总记录数 {total_size}")

    def process_page(orders, page_num):
        nonlocal all_orders, seen_combinations
        valid_orders = []
        for order in orders:
            oid = order.get('orderId')
            pn = order.get('packageNumber')
            if not oid:
                logger.warning(f"第 {page_num} 页发现缺少 orderId 的订单: {order}")
                continue
            if not pn:
                logger.warning(f"第 {page_num} 页订单 {oid} 缺少 packageNumber，跳过")
                continue
            valid_orders.append(order)

        if not valid_orders:
            return

        new_orders = []
        for order in valid_orders:
            oid = order['orderId']
            pn = order['packageNumber']
            key = (oid, pn)
            if key in seen_combinations:
                logger.warning(f"第 {page_num} 页发现重复订单: orderId={oid}, packageNumber={pn} —— 将被去重跳过")
            else:
                # logger.info(f"第 {page_num} 页新增订单: orderId={oid}, packageNumber={pn}")
                seen_combinations.add(key)
                new_orders.append(order)

        if new_orders:
            all_orders.extend(new_orders)
            logger.info(f"第 {page_num} 页新增 {len(new_orders)} 条不重复订单，累计 {len(all_orders)} 条")
        else:
            logger.info(f"第 {page_num} 页全部重复，跳过")

    process_page(first_orders, 1)

    for page in range(2, total_page + 1):
        try:
            orders, _, _ = fetch_orders_page(page, payload_template)
        except Exception as e:
            logger.error(f"第 {page} 页请求失败: {e}，继续下一页")
            continue
        process_page(orders, page)
        time.sleep(REQUEST_INTERVAL)

    logger.info(f"抓取结束，共 {len(all_orders)} 条唯一订单（基于 order_id+package_number）")
    return all_orders


# ======================== 构建不同模式的 payload ========================
def build_payload_for_mode(mode: str) -> Dict[str, Any]:
    """
    根据模式生成请求参数：
      - full: history=all
      - recent: history= 空字符串（不限制）
    """
    payload = BASE_PAYLOAD.copy()
    if mode == 'full':
        payload['history'] = 'all'
        logger.info("全量历史模式: history=all")
    else:  # recent
        payload['history'] = ''
        logger.info("最近120天模式: history= 空 (由接口默认行为决定，通常为最近120天)")
    return payload


# ======================== 主程序 ========================
def main():
    parser = argparse.ArgumentParser(description='抓取店小秘订单')
    parser.add_argument('--mode', type=str, choices=['full', 'recent'], default=None,
                        help='抓取模式: full=全量历史, recent=最近120天 (默认使用环境变量 FETCH_MODE，若无则 recent)')
    args = parser.parse_args()

    if args.mode:
        mode = args.mode
    else:
        mode = os.getenv('FETCH_MODE', 'recent')
        if mode not in ('full', 'recent'):
            logger.warning(f"无效的 FETCH_MODE 环境变量: {mode}，将使用默认模式 recent")
            mode = 'recent'

    logger.info(f"===== 店小秘订单抓取开始，模式: {mode} =====")
    init_database()

    payload = build_payload_for_mode(mode)
    # 可选：打印 payload 用于调试
    # logger.debug(f"Request payload: {payload}")

    orders = fetch_all_orders(payload)
    if orders:
        save_orders_batch(orders)
    else:
        logger.warning("未抓取到任何订单数据，请检查 Cookie 是否过期或参数是否正确")

    logger.info("===== 抓取任务完成 =====")


if __name__ == "__main__":
    main()