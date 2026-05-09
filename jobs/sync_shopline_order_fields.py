"""
多店铺 Shopline：Admin REST 分页订单列表按 order_id 匹配本地 orders，写入扩展字段。
文档：GET /admin/openapi/{version}/orders.json，Bearer Token，分页见响应 Link 头 page_info。
单笔详情：--fetch-detail 或 SHOPLINE_FETCH_ORDER_DETAIL=1。
列表无 device：--fetch-detail-if-no-device 或 SHOPLINE_FETCH_DETAIL_IF_NO_DEVICE=1。
店铺：SHOPLINE_STORES_JSON 或 SHOPLINE_STORE_DOMAIN（或 SHOPLINE_STORE_HANDLE）+ SHOPLINE_ACCESS_TOKEN。
每店订单号前缀：JSON 内 orderIdPrefix；未写时每店仍可读 SHOPLINE_ORDER_ID_PREFIX。匹配仅用 name（先拼前缀再 expand）。
配置了前缀时，仅更新 order_id 以该前缀开头的行，避免尾号与其它卖家 id 在库中共存时串单。
调试：--debug-fetch / SHOPLINE_DEBUG_FETCH=1。
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
import urllib.parse
from datetime import datetime
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

SHOPLINE_API_VERSION = os.getenv("SHOPLINE_API_VERSION", "v20260301").strip() or "v20260301"
SHOPLINE_SORT_CONDITION = (os.getenv("SHOPLINE_SORT_CONDITION") or "order_at:desc").strip()
LIST_PAGE_SIZE = min(int(os.getenv("SHOPLINE_LIST_PAGE_SIZE", "100")), 100)
LIST_INTERVAL_SEC = float(os.getenv("SHOPLINE_LIST_INTERVAL", "0.25"))
REQUEST_INTERVAL_SEC = float(os.getenv("SHOPLINE_FETCH_INTERVAL", "0.25"))


def env_fetch_order_detail_enabled() -> bool:
    """是否允许在列表缺字段时 GET 单笔订单（默认关，见模块说明）。"""
    v = (os.getenv("SHOPLINE_FETCH_ORDER_DETAIL") or "").strip().lower()
    return v in ("1", "true", "yes")


def env_fetch_detail_if_no_device_enabled() -> bool:
    """列表无 device 时再 GET 单笔订单（不少店铺列表响应根本不返回 device 键）。"""
    v = (os.getenv("SHOPLINE_FETCH_DETAIL_IF_NO_DEVICE") or "").strip().lower()
    return v in ("1", "true", "yes")


def env_debug_fetch_enabled() -> bool:
    """是否打印列表命中单的原始 JSON 片段与抽取结果（SHOPLINE_DEBUG_FETCH=1）。"""
    v = (os.getenv("SHOPLINE_DEBUG_FETCH") or "").strip().lower()
    return v in ("1", "true", "yes")


def format_sync_fetch_debug(
    store_domain: str,
    order_id_hit: str,
    raw: Dict[str, Any],
    base: Dict[str, Any],
    row: Dict[str, Any],
) -> str:
    """便于对照：接口列表项 → normalize 后 → extract_sync_row（即将写入 DB 的行）。"""

    def snap(d: Dict[str, Any]) -> Dict[str, Any]:
        keys = sorted(str(k) for k in d.keys())
        return {
            "key_count": len(keys),
            "keys_sample": keys[:60],
            "device": d.get("device"),
            "browser_ip": d.get("browser_ip"),
            "landing_site": (str(d.get("landing_site") or "")[:120]),
            "last_landing_url": (str(d.get("last_landing_url") or "")[:120]),
            "payment_method": d.get("payment_method"),
            "payment_gateway_names": d.get("payment_gateway_names"),
            "id": d.get("id"),
            "number": d.get("number"),
            "name": d.get("name"),
        }

    payload = {
        "store": store_domain,
        "matched_order_id": order_id_hit,
        "list_api_item_raw": snap(raw),
        "after_normalize_list_order_item": snap(base),
        "extract_sync_row": {
            "client_ip": row.get("client_ip"),
            "last_landing_url": row.get("last_landing_url"),
            "device": row.get("device"),
            "payment_method": row.get("payment_method"),
            "payment_channel": row.get("payment_channel"),
            "variant_id": row.get("variant_id"),
            "order_created_time": row.get("order_created_time"),
        },
    }
    return json.dumps(payload, ensure_ascii=False, default=str)


SYNC_COLUMN_SPECS: List[Tuple[str, str]] = [
    ("client_ip", "VARCHAR(45) DEFAULT NULL COMMENT '客户端 IP（Shopline）'"),
    ("order_created_time", "DATETIME DEFAULT NULL COMMENT 'Shopline 订单创建时间'"),
    ("last_landing_url", "TEXT DEFAULT NULL COMMENT '末次落地页 URL'"),
    ("device", "VARCHAR(512) DEFAULT NULL COMMENT '设备/UA 等'"),
    ("payment_method", "VARCHAR(100) DEFAULT NULL COMMENT '支付方式'"),
    ("payment_channel", "VARCHAR(100) DEFAULT NULL COMMENT '支付渠道'"),
    ("variant_id", "VARCHAR(255) DEFAULT NULL COMMENT 'SKU/变体 ID（多行商品取首行）'"),
]


def _column_exists(cursor, db_name: str, column_name: str) -> bool:
    cursor.execute(
        """
        SELECT COUNT(1) FROM information_schema.columns
        WHERE table_schema = %s AND table_name = 'orders' AND column_name = %s
        """,
        (db_name, column_name),
    )
    return bool(cursor.fetchone()[0])


def ensure_sync_columns(cursor) -> None:
    db_name = MYSQL_CONFIG["database"]
    after = "transaction_id"
    for col, ddl in SYNC_COLUMN_SPECS:
        if _column_exists(cursor, db_name, col):
            after = col
            continue
        cursor.execute(f"ALTER TABLE orders ADD COLUMN `{col}` {ddl} AFTER `{after}`")
        logger.info("已为 orders 表新增字段 %s", col)
        after = col


def load_stores() -> List[Dict[str, str]]:
    raw = (os.getenv("SHOPLINE_STORES_JSON") or "").strip()
    stores: List[Dict[str, str]] = []
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    domain = str(
                        item.get("storeDomain")
                        or item.get("store_domain")
                        or item.get("storeHost")
                        or item.get("store_host")
                        or ""
                    ).strip()
                    token = str(
                        item.get("accessToken")
                        or item.get("access_token")
                        or item.get("adminToken")
                        or item.get("admin_token")
                        or ""
                    ).strip()
                    if domain and token:
                        rec: Dict[str, str] = {"storeDomain": domain, "adminToken": token}
                        pfx = str(
                            item.get("orderIdPrefix")
                            or item.get("order_id_prefix")
                            or item.get("shoplineOrderIdPrefix")
                            or os.getenv("SHOPLINE_ORDER_ID_PREFIX")
                            or ""
                        ).strip()
                        if pfx:
                            rec["orderIdPrefix"] = pfx
                        stores.append(rec)
        except json.JSONDecodeError as e:
            logger.error("SHOPLINE_STORES_JSON 解析失败: %s", e)
    if stores:
        return stores

    domain = (
        os.getenv("SHOPLINE_STORE_DOMAIN")
        or os.getenv("SHOPLINE_STORE_HANDLE")
        or ""
    ).strip()
    if domain and "." not in domain:
        domain = f"{domain}.myshopline.com"
    token = (os.getenv("SHOPLINE_ACCESS_TOKEN") or "").strip()
    if domain and token:
        rec: Dict[str, str] = {"storeDomain": domain, "adminToken": token}
        pfx = (os.getenv("SHOPLINE_ORDER_ID_PREFIX") or "").strip()
        if pfx:
            rec["orderIdPrefix"] = pfx
        return [rec]

    raise RuntimeError(
        "缺少店铺配置：请设置 SHOPLINE_STORES_JSON，或 SHOPLINE_STORE_DOMAIN / SHOPLINE_STORE_HANDLE + SHOPLINE_ACCESS_TOKEN"
    )


def orders_list_url_from_path(store_domain: str, path: str, query: Dict[str, str]) -> str:
    path = path if path.startswith("/") else "/" + path
    q = urllib.parse.urlencode(query)
    return f"https://{store_domain}{path}?{q}"


def shopline_orders_list_path() -> str:
    """Shopline Admin REST：版本化 orders 列表。"""
    return f"/admin/openapi/{SHOPLINE_API_VERSION}/orders.json"


def shopline_headers(token: str) -> Dict[str, str]:
    return {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": f"Bearer {token}",
    }


def api_json_headers(token: str) -> Dict[str, str]:
    h = shopline_headers(token)
    h["Accept"] = "application/json"
    return h


def shopline_link_next_page_info(resp_headers: Any) -> Optional[str]:
    """从 Link 头解析 rel=next 的 page_info 查询参数。"""
    link = None
    if hasattr(resp_headers, "get"):
        link = resp_headers.get("Link") or resp_headers.get("link")
    if not link:
        return None
    for segment in str(link).split(","):
        segment = segment.strip()
        if 'rel="next"' not in segment and "rel='next'" not in segment.lower():
            continue
        if "<" not in segment or ">" not in segment:
            continue
        url = segment.split("<", 1)[1].split(">", 1)[0]
        qs = urllib.parse.urlparse(url).query
        vals = urllib.parse.parse_qs(qs).get("page_info")
        if vals:
            return vals[0]
    return None


def configure_insecure_tls_warnings(verify_tls: bool) -> None:
    if verify_tls:
        return
    try:
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    except Exception:
        pass


def pick_order_obj(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    从详情 JSON 取出订单对象。OpenAPI 常见形态：
      {"data": {"order": {...}, "device": "PC"}}
    原先只返回内层 order，会丢掉与 order 同级的 device / last_landing_url 等字段。
    """
    if not data:
        return {}

    def non_empty(val: Any) -> bool:
        if val is None:
            return False
        if isinstance(val, str):
            return bool(val.strip())
        if isinstance(val, (list, dict)):
            return len(val) > 0
        return True

    # 与 data/order 同级、需并入订单对象的补充键（Shoplazza 常把 device 放在外层）
    wrapper_extra_keys = (
        "device",
        "variant_id",
        "last_landing_url",
        "landing_url",
        "user_agent",
        "browser_ip",
        "landing_site",
        "referring_site",
    )

    # 先认扁平订单：根上有 id / number（Shoplazza 列表）则整体返回。
    # 避免根上另有 data:{} 等 dict 时先进入下面循环，误把非订单 dict 当成主体丢掉 device。
    if (
        isinstance(data.get("id"), (str, int, float))
        or isinstance(data.get("order_number"), str)
        or isinstance(data.get("number"), (str, int))
    ):
        return data

    # 详情接口直接返回扁平片段（无 id / order_number），例如仅含 create_at、browser_ip、device…
    snippet_markers = (
        "create_at",
        "created_at",
        "order_at",
        "browser_ip",
        "last_landing_url",
        "landing_site",
        "device",
        "payment_method",
        "payment_channel",
        "payment_gateway_names",
    )
    if any(k in data for k in snippet_markers):
        return data

    for key in ("order", "data", "result"):
        v = data.get(key)
        if not isinstance(v, dict):
            continue
        inner = v.get("order") if isinstance(v.get("order"), dict) else None
        if inner is not None:
            merged = dict(inner)
            for ek in wrapper_extra_keys:
                if ek not in merged or not non_empty(merged.get(ek)):
                    ev = data.get(ek)
                    if not non_empty(ev) and isinstance(v, dict):
                        ev = v.get(ek)
                    if non_empty(ev):
                        merged[ek] = ev
            return merged
        # 无嵌套 order 时：仅当 v 本身像一笔订单（含 id/number）才采纳；避免 data:{} 误判
        if isinstance(v.get("id"), (str, int, float)) or isinstance(v.get("order_number"), str) or isinstance(
            v.get("number"), (str, int)
        ):
            merged = dict(v)
            for ek in wrapper_extra_keys:
                if ek not in merged or not non_empty(merged.get(ek)):
                    ev = data.get(ek)
                    if not non_empty(ev):
                        ev = v.get(ek)
                    if non_empty(ev):
                        merged[ek] = ev
            return merged

    return {}


def normalize_list_order_item(raw: Dict[str, Any]) -> Dict[str, Any]:
    """列表里每条订单可能是扁平 JSON，也可能是 { data: { order, device } }；统一成单笔对象再匹配、抽字段。

    必须以「接口原始 raw」为底再叠 pick_order_obj 的结果：pick_order_obj 有时会返回较窄的对象，
    若直接用 norm 会丢掉顶层 device / browser_ip（表现为其它字段能 UPDATE、唯独 device 一直是 NULL）。
    """
    norm = pick_order_obj(raw)
    out = dict(raw)
    if not norm:
        return out
    for k, v in norm.items():
        if v is None:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        if isinstance(v, (list, dict)) and len(v) == 0:
            continue
        out[k] = v
    return out


def extract_orders_array(data: Any) -> List[Dict[str, Any]]:
    """从列表接口 JSON 中取出订单数组。"""
    if not isinstance(data, dict):
        return []
    for key in ("orders", "results"):
        v = data.get(key)
        if isinstance(v, list):
            return [x for x in v if isinstance(x, dict)]
    inner = data.get("data")
    if isinstance(inner, list):
        return [x for x in inner if isinstance(x, dict)]
    if isinstance(inner, dict):
        for key in ("orders", "list", "results"):
            v = inner.get(key)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
    return []


def extract_next_page_token(data: Dict[str, Any]) -> Optional[str]:
    """当前响应里用于请求下一页的 cursor / page_token。"""
    for root in (data, data.get("data") if isinstance(data.get("data"), dict) else None):
        if not isinstance(root, dict):
            continue
        pi = root.get("page_info") or root.get("pageInfo") or root.get("pagination")
        if isinstance(pi, dict):
            nxt = pi.get("next") or pi.get("next_page_token") or pi.get("nextToken") or pi.get("end_cursor")
            if nxt:
                return str(nxt)
        for key in ("next_page_token", "next_token", "page_token"):
            nxt = root.get(key)
            if nxt:
                return str(nxt)
    return None


def expand_match_tokens(raw: Any) -> Set[str]:
    """同一订单号多种写法（去 #、纯数字去前导零等），便于与本地 order_id 对齐。"""
    if raw is None:
        return set()
    s = str(raw).strip()
    if not s:
        return set()
    out: Set[str] = {s}
    if s.startswith("#"):
        t = s[1:].strip()
        if t:
            out.add(t)
    if s.isdigit():
        try:
            out.add(str(int(s)))
        except ValueError:
            pass
    # Shoplazza id 常见「店铺ID-单号」；本地 order_id 常只存与 number 一致的后半段
    if "-" in s:
        tail = s.rsplit("-", 1)[-1].strip()
        if tail and tail != s:
            out.add(tail)
    lo = s.lower()
    if lo != s:
        out.add(lo)
    return {x for x in out if x}


def normalize_order_id_str(raw: Any) -> Optional[str]:
    """与 DB / 接口对齐：去首尾空白，避免与接口 id 肉眼一致但字符串不相等。"""
    if raw is None:
        return None
    s = str(raw).strip()
    return s if s else None


def _shopline_name_already_has_prefix(name: str, prefix: str) -> bool:
    """
    判断 name 是否已是「带店铺前缀的完整单号」，避免重复拼接。
    不能用裸 startswith(prefix)：如 prefix=10 会误判 #1001（1001 以 10 开头）。
    """
    p = (prefix or "").strip()
    if not name or not p:
        return False
    if name == p:
        return True
    if name.startswith(p) and p.endswith("-"):
        return True
    if name.startswith(p + "-"):
        return True
    return False


def _shopline_prefixed_api_id_tokens(raw: Any, prefix: str) -> Set[str]:
    """
    接口 name 常为短单号（如 1146）；库 order_id 为「店铺前缀 + 单号」（如 8266323-1146）。
    在尚未带前缀时：先拼 prefix + 去掉 # 后的正文，再 expand（含尾段变体）。
    prefix 无尾部「-」时额外尝试插入「-」再 expand。
    """
    p = (prefix or "").strip()
    if not p or raw is None:
        return set()
    s = str(raw).strip()
    if not s or _shopline_name_already_has_prefix(s, p):
        return set()
    bare = s[1:].strip() if s.startswith("#") else s
    if not bare or _shopline_name_already_has_prefix(bare, p):
        return set()
    out: Set[str] = set()
    out |= expand_match_tokens(p + bare)
    if not p.endswith("-") and not bare.startswith("-"):
        out |= expand_match_tokens(p + "-" + bare)
    return out


def _dedupe_tokens_preserve_order(tokens: List[str]) -> List[str]:
    seen: Set[str] = set()
    out: List[str] = []
    for t in tokens:
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out


def _shopline_order_display_name(order: Dict[str, Any]) -> Optional[Any]:
    return (
        order.get("name")
        if order.get("name") is not None
        else order.get("order_name") or order.get("orderName")
    )


def order_api_match_tokens(
    order: Dict[str, Any],
    shop_order_id_prefix: Optional[str] = None,
) -> List[str]:
    """
    仅用接口 name。配置了 orderIdPrefix 时：先用「前缀 + name」与库匹配（如 name=1146 → 8266323-1146），
    再附加 name 原文的 expand 作为兜底。
    """
    v = _shopline_order_display_name(order)
    if v is None:
        return []
    pfx = (shop_order_id_prefix or "").strip()
    ordered: List[str] = []
    if pfx:
        pref = _shopline_prefixed_api_id_tokens(v, pfx)
        # 先试完整「前缀+单号」，避免纯数字先命中其它行（按长度降序）
        ordered.extend(sorted(pref, key=lambda t: (-len(str(t)), str(t))))
    ordered.extend(expand_match_tokens(v))
    return _dedupe_tokens_preserve_order(ordered)


def order_id_matches_shop_prefix(order_id: str, prefix: str) -> bool:
    """
    同一 DB 里可能有多卖家 order_id（如 8109139-1259 与 8266323-1259），
    短 token「1259」在 lookup 里会撞车。配置了本店 orderIdPrefix 时，只认以本店前缀开头的行。
    """
    p = (prefix or "").strip()
    if not p:
        return True
    oid = str(order_id).strip()
    if not oid:
        return False
    if oid.startswith(p):
        return True
    if not p.endswith("-"):
        return oid.startswith(p + "-")
    return False


def build_pending_lookup(pending: Set[str]) -> Dict[str, str]:
    """token 变体 -> 数据库中的 order_id（UPDATE 用）。"""
    lookup: Dict[str, str] = {}
    for oid in pending:
        for t in expand_match_tokens(oid):
            if t not in lookup:
                lookup[t] = oid
    return lookup


def extract_client_ip(order: Dict[str, Any]) -> Optional[str]:
    if not order:
        return None
    candidates = [
        order.get("browser_ip"),
        order.get("client_ip"),
        order.get("customer_ip"),
        order.get("ip"),
        order.get("remote_ip"),
        order.get("source_ip"),
        order.get("order_ip"),
    ]
    client_details = order.get("client_details")
    if isinstance(client_details, dict):
        candidates.extend(
            [
                client_details.get("browser_ip"),
                client_details.get("ip"),
            ]
        )
    for c in candidates:
        if c is None:
            continue
        s = str(c).strip()
        if s and len(s) <= 45:
            return s
    return None


def _trunc_str(val: Any, max_len: int) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    return s[:max_len]


def parse_order_datetime(val: Any) -> Optional[datetime]:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.replace(tzinfo=None) if val.tzinfo else val
    if isinstance(val, (int, float)):
        v = float(val)
        if v > 1e12:
            v = v / 1000.0
        try:
            return datetime.utcfromtimestamp(v)
        except (OverflowError, OSError, ValueError):
            return None
    s = str(val).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo:
        dt = dt.replace(tzinfo=None)
    return dt


def _merge_nonempty_detail_value(v: Any) -> bool:
    """详情里的字段是否应覆盖列表同名字段（避免详情里的 null/空串盖掉列表已有值）。"""
    if v is None:
        return False
    if isinstance(v, str):
        return bool(v.strip())
    if isinstance(v, (list, dict)):
        return len(v) > 0
    return True


def merge_list_and_detail_order(list_o: Dict[str, Any], detail_o: Dict[str, Any]) -> Dict[str, Any]:
    """
    以列表项为底，用详情补全；详情中为 null/空串的键不覆盖列表（Shoplazza 常见：
    列表带 last_landing_url/device，详情同一字段为 null，原先会被 {**a,**b} 冲掉）。
    """
    out = dict(list_o)
    for k, v in detail_o.items():
        if k == "client_details":
            continue
        if not _merge_nonempty_detail_value(v):
            continue
        out[k] = v

    cl = list_o.get("client_details")
    cd = detail_o.get("client_details")
    if isinstance(cl, dict) and isinstance(cd, dict):
        merged_cd = dict(cl)
        for ck, cv in cd.items():
            if not _merge_nonempty_detail_value(cv):
                continue
            merged_cd[ck] = cv
        out["client_details"] = merged_cd
    elif isinstance(cd, dict):
        out["client_details"] = cd
    elif isinstance(cl, dict):
        out["client_details"] = cl
    return out


def _dig(d: Any, *keys: str) -> Any:
    cur: Any = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _first_nonempty_str(*vals: Any) -> Optional[str]:
    for v in vals:
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return None


def _case_insensitive_pick(d: Any, *want_lower: str) -> Optional[str]:
    """从 dict 里按 key 小写匹配取第一个非空字符串。"""
    if not isinstance(d, dict):
        return None
    lm = {str(k).lower(): v for k, v in d.items()}
    for w in want_lower:
        v = lm.get(w.lower())
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return None


def _extract_from_kv_arrays(order: Dict[str, Any], url_hints: Set[str], ua_hints: Set[str]) -> Tuple[Optional[str], Optional[str]]:
    """从 note_attributes / attributes / cart_attributes 等 {name,value} 列表里找落地页与 UA。"""
    landing: Optional[str] = None
    ua: Optional[str] = None
    for arr_key in (
        "note_attributes",
        "noteAttributes",
        "attributes",
        "cart_attributes",
        "cartAttributes",
        "custom_attributes",
        "metafields",
    ):
        arr = order.get(arr_key)
        if not isinstance(arr, list):
            continue
        for item in arr:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("key") or "").strip().lower()
            val = item.get("value") or item.get("values")
            if isinstance(val, list):
                val = val[0] if val else None
            if val is None:
                continue
            vs = str(val).strip()
            if not vs:
                continue
            if landing is None and name and any(h in name for h in url_hints):
                landing = vs
            if ua is None and name and any(h in name for h in ua_hints):
                ua = vs
    return landing, ua


def _source_url_if_http(order: Dict[str, Any]) -> Optional[str]:
    """Shoplazza 列表常见 source 为商品/落地 URL 字符串，与 last_landing_url 二选一或并存。"""
    s = order.get("source")
    if not isinstance(s, str):
        return None
    t = s.strip()
    return t if t.startswith(("http://", "https://")) else None


def _extract_device_from_kv_arrays(order: Dict[str, Any]) -> Optional[str]:
    """与 last_landing_url 用 attr_landing 补全同理：从 note_attributes / attributes 等取 device。"""
    exact = frozenset(
        {
            "device",
            "device_type",
            "client_device",
            "user_device",
            "terminal",
            "equipment",
            "equipment_type",
        }
    )
    sub_needles = ("device_type", "client_device", "user_device", "equipment")
    for arr_key in (
        "note_attributes",
        "noteAttributes",
        "attributes",
        "cart_attributes",
        "cartAttributes",
        "custom_attributes",
        "metafields",
    ):
        arr = order.get(arr_key)
        if not isinstance(arr, list):
            continue
        for item in arr:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("key") or "").strip().lower()
            if not name:
                continue
            if name not in exact and not any(n in name for n in sub_needles):
                continue
            val = item.get("value") or item.get("values")
            if isinstance(val, list):
                val = val[0] if val else None
            if val is None:
                continue
            vs = str(val).strip()
            if not vs:
                continue
            if vs.startswith(("http://", "https://", "//")):
                continue
            return vs
    return None


def _extract_variant_id(order: Dict[str, Any]) -> Optional[str]:
    """订单顶层或 line_items 首行的变体 ID（多行商品仅取第一行有 variant 的行）。"""
    v = _first_nonempty_str(
        order.get("variant_id"),
        order.get("variantId"),
        order.get("product_variant_id"),
        order.get("productVariantId"),
        _dig(order, "variant", "id"),
    )
    if v:
        return v[:255]
    for key in ("line_items", "lineItems"):
        items = order.get(key)
        if not isinstance(items, list):
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            inner = _first_nonempty_str(
                it.get("variant_id"),
                it.get("variantId"),
                it.get("product_variant_id"),
                _dig(it, "variant", "id"),
                _dig(it, "product_variant", "id"),
            )
            if inner:
                return inner[:255]
    return None


def extract_sync_row(order: Dict[str, Any]) -> Dict[str, Any]:
    if not order:
        return {
            "client_ip": None,
            "order_created_time": None,
            "last_landing_url": None,
            "device": None,
            "payment_method": None,
            "payment_channel": None,
            "variant_id": None,
        }

    cd = order.get("client_details") if isinstance(order.get("client_details"), dict) else {}

    created_raw = (
        order.get("order_at")
        or order.get("created_at")
        or order.get("create_at")
        or order.get("placed_at")
        or order.get("order_created_at")
        or order.get("createdAt")
        or order.get("createAt")
        or order.get("placedAt")
    )

    # Shoplazza / Shopify 系常见字段名差异较大，尽量多候选
    landing = _first_nonempty_str(
        order.get("last_landing_url"),
        order.get("landing_url"),
        order.get("landing_page_url"),
        order.get("landing_site"),
        order.get("landing_site_ref"),
        order.get("referring_site"),
        order.get("referrer_url"),
        order.get("referrer"),
        order.get("source_url"),
        _source_url_if_http(order),
        order.get("landing_page"),
        cd.get("last_landing_url"),
        cd.get("landing_url"),
        cd.get("landing_page_url"),
        cd.get("landing_site"),
        cd.get("landing_site_ref"),
        cd.get("referring_site"),
        cd.get("referrer_url"),
        cd.get("referrer"),
        cd.get("source_url"),
        _dig(cd, "landing_site"),
        _dig(cd, "referring_site"),
        _dig(order, "customer_visit", "landing_page"),
        _dig(order, "session", "landing_page"),
        _dig(order, "checkout", "landing_site"),
    )

    attr_landing, attr_ua = _extract_from_kv_arrays(
        order,
        url_hints={
            "landing",
            "referer",
            "referrer",
            "page_url",
            "pageurl",
            "last_landing",
            "source_url",
            "utm",
            "entry",
        },
        # 不要用子串 "device"：note 里常见 device_xxx 属性名，会污染 attr_ua，进而干扰下方 device 字段
        ua_hints={
            "user_agent",
            "useragent",
            "browser",
            "ua",
        },
    )
    if not landing:
        landing = attr_landing

    attr_device = _extract_device_from_kv_arrays(order)

    device = _first_nonempty_str(
        order.get("device"),
        _case_insensitive_pick(order, "device"),
        _dig(order, "device", "type"),
        _dig(order, "device", "name"),
        _dig(order, "device", "label"),
        _dig(order, "device", "value"),
        order.get("device_type"),
        order.get("device_model"),
        _dig(order, "browser", "device"),
        _dig(order, "visitor", "device"),
        attr_device,
        order.get("user_agent"),
        order.get("http_user_agent"),
        order.get("request_agent"),
        cd.get("user_agent"),
        cd.get("http_user_agent"),
        cd.get("device"),
        _case_insensitive_pick(cd, "device"),
        cd.get("device_type"),
        cd.get("browser"),
        cd.get("ua"),
        _dig(cd, "browser", "user_agent"),
        _case_insensitive_pick(cd, "user_agent", "user-agent", "http_user_agent"),
        _case_insensitive_pick(order, "user_agent", "http_user_agent"),
        attr_ua,
    )

    pay_method = (
        order.get("payment_method")
        or order.get("paymentMethod")
        or order.get("gateway")
        or order.get("processing_method")
    )
    transactions = order.get("transactions")
    if isinstance(transactions, list) and transactions:
        t0 = transactions[0] if isinstance(transactions[0], dict) else {}
        pay_method = pay_method or t0.get("gateway") or t0.get("payment_method")

    pay_channel = (
        order.get("payment_channel")
        or order.get("paymentChannel")
        or order.get("payment_gateway_name")
        or cd.get("payment_channel")
    )
    pgn = order.get("payment_gateway_names")
    if pay_channel is None and isinstance(pgn, list) and pgn:
        joined = ",".join(str(x).strip() for x in pgn if x is not None and str(x).strip())
        if joined:
            pay_channel = joined

    return {
        "client_ip": extract_client_ip(order),
        "order_created_time": parse_order_datetime(created_raw),
        "last_landing_url": _trunc_str(landing, 65535),
        "device": _trunc_str(device, 512),
        "payment_method": _trunc_str(pay_method, 100),
        "payment_channel": _trunc_str(pay_channel, 100),
        "variant_id": _trunc_str(_extract_variant_id(order), 255),
    }


def sync_row_has_any_value(row: Dict[str, Any]) -> bool:
    return any(v is not None for v in row.values())


def sync_row_incomplete(row: Dict[str, Any]) -> bool:
    return any(v is None for v in row.values())


def shopline_order_detail_url(store_domain: str, order_id: str) -> str:
    """GET /admin/openapi/{version}/orders/{id}.json"""
    oid = urllib.parse.quote(str(order_id), safe="")
    path = f"/admin/openapi/{SHOPLINE_API_VERSION}/orders/{oid}.json"
    return f"https://{store_domain}{path}"


def fetch_order_detail(
    session: requests.Session,
    store: Dict[str, str],
    order_id: str,
    verify_tls: bool,
) -> Tuple[bool, Dict[str, Any]]:
    domain = store["storeDomain"]
    token = store["adminToken"]
    url = shopline_order_detail_url(domain, order_id)
    try:
        resp = session.get(url, headers=api_json_headers(token), timeout=60, verify=verify_tls)
        if resp.status_code == 404:
            return False, {}
        resp.raise_for_status()
        try:
            data = resp.json()
        except ValueError:
            return False, {}
        if isinstance(data, dict):
            obj = pick_order_obj(data)
            if obj:
                return True, obj
    except requests.RequestException as e:
        logger.debug("单笔订单请求失败 url=%s err=%s", url, e)
    return False, {}


def fetch_orders_list_page(
    session: requests.Session,
    store: Dict[str, str],
    page_size: int,
    page_info: Optional[str],
    verify_tls: bool,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Shopline：GET /admin/openapi/{version}/orders.json
    首屏传 limit + sort_condition；下一页用 Link 头 rel=next 的 page_info。
    返回 (orders, next_page_info)。
    """
    path = shopline_orders_list_path()
    q: Dict[str, str] = {"limit": str(page_size)}
    if page_info:
        q["page_info"] = page_info
    elif SHOPLINE_SORT_CONDITION:
        q["sort_condition"] = SHOPLINE_SORT_CONDITION

    domain = store["storeDomain"]
    token = store["adminToken"]
    url = orders_list_url_from_path(domain, path, q)

    resp = session.get(
        url,
        headers=api_json_headers(token),
        timeout=120,
        verify=verify_tls,
    )

    if resp.status_code in (401, 403):
        raise requests.RequestException(
            f"订单列表鉴权失败 HTTP {resp.status_code} final_url={resp.url}。"
            "请确认 access token 有效且具备订单读权限。"
        )

    if resp.status_code >= 400:
        snippet = (resp.text or "")[:220].replace("\n", " ")
        raise requests.RequestException(
            f"订单列表 HTTP {resp.status_code} url={resp.url} body_prefix={snippet!r}"
        )

    try:
        body = resp.json()
    except ValueError:
        snippet = (resp.text or "")[:220].replace("\n", " ")
        raise requests.RequestException(
            f"列表非 JSON final_url={resp.url} ct={resp.headers.get('Content-Type')} "
            f"body_prefix={snippet!r}"
        )

    if not isinstance(body, dict):
        raise requests.RequestException("订单列表根节点不是 JSON object")

    orders = extract_orders_array(body)
    errs = body.get("errors")
    if errs and not orders:
        logger.warning("订单列表 API 返回 errors 且无订单 errors=%s", errs)

    next_pi = shopline_link_next_page_info(resp.headers) or extract_next_page_token(body)
    logger.debug("列表 store=%s path=%s n=%s next_page_info=%s", domain, path, len(orders), bool(next_pi))
    return orders, next_pi


def fetch_distinct_order_ids(cursor, only_missing: bool, limit: Optional[int]) -> List[str]:
    sql = "SELECT DISTINCT order_id FROM orders"
    params: List[Any] = []
    if only_missing:
        sql += """ WHERE (
            client_ip IS NULL OR client_ip = ''
            OR order_created_time IS NULL
            OR last_landing_url IS NULL OR last_landing_url = ''
            OR device IS NULL OR device = ''
            OR payment_method IS NULL OR payment_method = ''
            OR payment_channel IS NULL OR payment_channel = ''
            OR variant_id IS NULL OR variant_id = ''
        )"""
    sql += " ORDER BY order_id"
    if limit is not None:
        sql += " LIMIT %s"
        params.append(int(limit))
    cursor.execute(sql, params)
    out: List[str] = []
    seen: Set[str] = set()
    for row in cursor.fetchall():
        oid = normalize_order_id_str(row[0])
        if oid and oid not in seen:
            seen.add(oid)
            out.append(oid)
    return out


def apply_sync_row_update(cursor, order_id_key: str, row: Dict[str, Any]) -> int:
    cols: List[str] = []
    vals: List[Any] = []
    for col in (
        "client_ip",
        "order_created_time",
        "last_landing_url",
        "device",
        "payment_method",
        "payment_channel",
        "variant_id",
    ):
        v = row.get(col)
        if v is not None:
            cols.append(f"`{col}` = %s")
            vals.append(v)
    if not cols:
        return 0
    vals.append(order_id_key)
    cursor.execute(f"UPDATE orders SET {', '.join(cols)} WHERE order_id = %s", vals)
    if cursor.rowcount == 0:
        logger.debug("UPDATE 0 行 order_id=%r", order_id_key)
    return cursor.rowcount


def sync_fields_by_store_list(
    cursor,
    stores: List[Dict[str, str]],
    session: requests.Session,
    pending: Set[str],
    pending_lookup: Dict[str, str],
    dry_run: bool,
    verify_tls: bool,
    detail_if_incomplete: bool,
    detail_if_no_device: bool,
    max_pages_per_store: Optional[int],
    debug_fetch: bool,
    debug_fetch_remaining: Optional[List[Optional[int]]],
) -> Dict[str, int]:
    stats = {
        "pending_start": len(pending),
        "pages": 0,
        "orders_scanned": 0,
        "matched_rows_updated": 0,
        "no_values_after_detail": 0,
        "skipped_dry": 0,
        "detail_fetches": 0,
        "stores_completed": 0,
    }
    for store in stores:
        if not pending:
            break

        page_token: Optional[str] = None
        pages_this_store = 0

        hits_this_store = 0
        pending_at_store_start = len(pending)

        while True:
            if not pending:
                break
            if max_pages_per_store is not None and pages_this_store >= max_pages_per_store:
                logger.info("%s 已达 max-pages=%s", store["storeDomain"], max_pages_per_store)
                break

            try:
                orders, next_tok = fetch_orders_list_page(
                    session,
                    store,
                    LIST_PAGE_SIZE,
                    page_token,
                    verify_tls,
                )
            except requests.RequestException as e:
                logger.error("列表请求失败 store=%s page_token=%s err=%s", store["storeDomain"], bool(page_token), e)
                break

            time.sleep(LIST_INTERVAL_SEC)
            stats["pages"] += 1
            pages_this_store += 1
            stats["orders_scanned"] += len(orders)

            if debug_fetch and orders and pages_this_store == 1:
                o0 = orders[0]
                logger.info(
                    "[debug-fetch] 首条 keys=%s device=%r id=%r",
                    sorted(str(k) for k in o0.keys()),
                    o0.get("device"),
                    o0.get("id"),
                )

            hits_this_page = 0
            for order in orders:
                if not pending:
                    break
                base = normalize_list_order_item(order)
                hit: Optional[str] = None
                eff_pfx = (store.get("orderIdPrefix") or os.getenv("SHOPLINE_ORDER_ID_PREFIX") or "").strip()
                for tok in order_api_match_tokens(base, eff_pfx or None):
                    oid = pending_lookup.get(tok)
                    if oid is None or oid not in pending:
                        continue
                    if eff_pfx and not order_id_matches_shop_prefix(oid, eff_pfx):
                        continue
                    hit = oid
                    break
                if not hit:
                    continue

                hits_this_page += 1
                hits_this_store += 1

                merged: Dict[str, Any] = dict(base)
                row = extract_sync_row(merged)
                need_detail = (detail_if_incomplete and sync_row_incomplete(row)) or (
                    detail_if_no_device and row.get("device") is None
                )
                if need_detail:
                    time.sleep(REQUEST_INTERVAL_SEC)
                    ok, detail = fetch_order_detail(session, store, hit, verify_tls)
                    stats["detail_fetches"] += 1
                    if ok:
                        merged = merge_list_and_detail_order(base, detail)
                        row = extract_sync_row(merged)

                if debug_fetch and debug_fetch_remaining is not None:
                    bud = debug_fetch_remaining[0]
                    if bud is None or bud > 0:
                        logger.info("[debug-fetch] hit=%s %s", hit, format_sync_fetch_debug(store["storeDomain"], hit, order, base, row))
                        if bud is not None:
                            debug_fetch_remaining[0] = bud - 1

                if not sync_row_has_any_value(row):
                    stats["no_values_after_detail"] += 1
                    pending.discard(hit)
                    continue

                if dry_run:
                    stats["skipped_dry"] += 1
                else:
                    stats["matched_rows_updated"] += apply_sync_row_update(cursor, hit, row)
                pending.discard(hit)

            logger.info(
                "%s page=%s list=%s hit=%s pending=%s updated=%s",
                store["storeDomain"],
                pages_this_store,
                len(orders),
                hits_this_page,
                len(pending),
                stats["matched_rows_updated"],
            )

            if not pending:
                break

            if not orders:
                break
            if next_tok:
                page_token = next_tok
                continue
            break

        stats["stores_completed"] += 1
        logger.info(
            "%s 结束 hits=%s pending_left=%s",
            store["storeDomain"],
            hits_this_store,
            len(pending),
        )
        if hits_this_store == 0 and pending_at_store_start > 0:
            logger.warning("%s 本店0命中（核对 order_id 与接口 name、orderIdPrefix 或加大翻页）", store["storeDomain"])

    stats["pending_end"] = len(pending)
    return stats


def sync_fields(
    dry_run: bool,
    only_missing: bool,
    limit: Optional[int],
    max_pages_per_store: Optional[int],
    detail_if_incomplete: bool,
    detail_if_no_device: bool,
    debug_fetch: bool,
    debug_fetch_max: int,
) -> Dict[str, int]:
    stores = load_stores()
    verify_tls = os.getenv("SHOPLINE_INSECURE_TLS", "").lower() not in ("1", "true", "yes")
    configure_insecure_tls_warnings(verify_tls)

    conn = pymysql.connect(**MYSQL_CONFIG)
    cursor = conn.cursor()
    try:
        ensure_sync_columns(cursor)
        conn.commit()

        order_ids = fetch_distinct_order_ids(cursor, only_missing, limit)
        dbg_fetch = debug_fetch or env_debug_fetch_enabled()
        dbg_budget: Optional[List[Optional[int]]] = None
        if dbg_fetch:
            dbg_budget = [None] if debug_fetch_max < 0 else [debug_fetch_max]
        logger.info(
            "pending=%s only_missing=%s detail=%s detail_if_no_device=%s page_size=%s debug_fetch=%s",
            len(order_ids),
            only_missing,
            detail_if_incomplete,
            detail_if_no_device,
            LIST_PAGE_SIZE,
            dbg_fetch,
        )

        session = requests.Session()

        pending_set = set(order_ids)
        pending_lookup = build_pending_lookup(pending_set)
        stats = sync_fields_by_store_list(
            cursor,
            stores,
            session,
            pending_set,
            pending_lookup,
            dry_run,
            verify_tls,
            detail_if_incomplete,
            detail_if_no_device,
            max_pages_per_store,
            dbg_fetch,
            dbg_budget,
        )
        conn.commit()
        return stats
    finally:
        cursor.close()
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="从 Shopline Admin REST 同步订单扩展字段到 orders（Link 分页 + 可选单笔补全）"
    )
    parser.add_argument("--dry-run", action="store_true", help="只统计不写库")
    parser.add_argument(
        "--only-missing",
        action="store_true",
        help="任一同步字段为空则纳入（见脚本内 SQL WHERE）",
    )
    parser.add_argument("--limit", type=int, default=None, help="最多加载多少个 distinct order_id（调试）")
    parser.add_argument(
        "--max-pages-per-store",
        type=int,
        default=None,
        help="每个店铺最多翻页数（调试；默认不限制）",
    )
    parser.add_argument(
        "--fetch-detail",
        action="store_true",
        help="列表缺字段时再 GET 单笔订单补全（默认关闭，device 等以列表返回为准）",
    )
    parser.add_argument(
        "--fetch-detail-if-no-device",
        action="store_true",
        help="仅当列表抽出 device 为空时再 GET 单笔（列表常不带 device 键；或 SHOPLINE_FETCH_DETAIL_IF_NO_DEVICE=1）",
    )
    parser.add_argument(
        "--debug-fetch",
        action="store_true",
        help="打印列表接口数据：每店第1页第1条的 keys；每条「命中」单的 raw→normalize→extract_sync_row（可用 SHOPLINE_DEBUG_FETCH=1）",
    )
    parser.add_argument(
        "--debug-fetch-max",
        type=int,
        default=40,
        help="与 --debug-fetch 合用：最多打印几条命中快照；-1 不限制（默认 40）",
    )
    args = parser.parse_args()

    if not MYSQL_CONFIG["database"]:
        logger.error("请配置 DB_NAME")
        raise SystemExit(1)

    detail_if_incomplete = args.fetch_detail or env_fetch_order_detail_enabled()
    detail_if_no_device = args.fetch_detail_if_no_device or env_fetch_detail_if_no_device_enabled()

    stats = sync_fields(
        dry_run=args.dry_run,
        only_missing=args.only_missing,
        limit=args.limit,
        max_pages_per_store=args.max_pages_per_store,
        detail_if_incomplete=detail_if_incomplete,
        detail_if_no_device=detail_if_no_device,
        debug_fetch=args.debug_fetch,
        debug_fetch_max=args.debug_fetch_max,
    )
    logger.info("done %s", stats)


if __name__ == "__main__":
    main()
