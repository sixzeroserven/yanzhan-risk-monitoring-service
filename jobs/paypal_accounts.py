"""Shared PayPal account/proxy configuration for Python jobs."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit

import requests


DEFAULT_PAYPAL_BASE_URL = "https://api-m.paypal.com"
DEFAULT_IP_ECHO_URL = "https://api.ipify.org?format=json"


@dataclass(frozen=True)
class PayPalAccount:
    name: str
    client_id: str
    client_secret: str
    base_url: str = DEFAULT_PAYPAL_BASE_URL
    proxy_url: str = ""


def _normalized_env_key(value: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", value.strip().upper()).strip("_")


def _clean_account_name(value: Any, fallback: str) -> str:
    name = str(value or "").strip()
    return name or fallback


def _clean_base_url(value: Any) -> str:
    return (str(value or "").strip() or DEFAULT_PAYPAL_BASE_URL).rstrip("/")


def _load_accounts_from_json(raw: str) -> List[PayPalAccount]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"PAYPAL_ACCOUNTS_JSON 不是合法 JSON：{exc}") from exc

    if not isinstance(data, list):
        raise SystemExit("PAYPAL_ACCOUNTS_JSON 必须是数组")

    accounts: List[PayPalAccount] = []
    for idx, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"PAYPAL_ACCOUNTS_JSON 第 {idx} 项必须是对象")
        name = _clean_account_name(item.get("name"), f"paypal_{idx}")
        client_id = str(item.get("client_id") or item.get("clientId") or "").strip()
        client_secret = str(item.get("client_secret") or item.get("clientSecret") or "").strip()
        proxy_url = str(item.get("proxy_url") or item.get("proxyUrl") or item.get("proxy") or "").strip()
        base_url = _clean_base_url(item.get("base_url") or item.get("baseUrl"))
        accounts.append(
            PayPalAccount(
                name=name,
                client_id=client_id,
                client_secret=client_secret,
                base_url=base_url,
                proxy_url=proxy_url,
            )
        )
    return accounts


def _load_accounts_from_keys(raw: str) -> List[PayPalAccount]:
    keys = [x.strip() for x in raw.split(",") if x.strip()]
    accounts: List[PayPalAccount] = []
    for key in keys:
        env_key = _normalized_env_key(key)
        if not env_key:
            continue
        prefix = f"PAYPAL_{env_key}"
        accounts.append(
            PayPalAccount(
                name=key,
                client_id=(os.getenv(f"{prefix}_CLIENT_ID") or "").strip(),
                client_secret=(os.getenv(f"{prefix}_CLIENT_SECRET") or "").strip(),
                base_url=_clean_base_url(os.getenv(f"{prefix}_BASE_URL")),
                proxy_url=(os.getenv(f"{prefix}_PROXY_URL") or "").strip(),
            )
        )
    return accounts


def _load_legacy_account() -> List[PayPalAccount]:
    client_id = (os.getenv("PAYPAL_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("PAYPAL_CLIENT_SECRET") or "").strip()
    if not client_id and not client_secret:
        return []
    return [
        PayPalAccount(
            name=(os.getenv("PAYPAL_ACCOUNT_NAME") or "default").strip() or "default",
            client_id=client_id,
            client_secret=client_secret,
            base_url=_clean_base_url(os.getenv("PAYPAL_BASE_URL")),
            proxy_url=(os.getenv("PAYPAL_PROXY_URL") or "").strip(),
        )
    ]


def _validate_accounts(accounts: List[PayPalAccount]) -> List[PayPalAccount]:
    if not accounts:
        raise SystemExit(
            "请配置 PAYPAL_ACCOUNTS_JSON / PAYPAL_ACCOUNT_KEYS，或兼容模式的 PAYPAL_CLIENT_ID 与 PAYPAL_CLIENT_SECRET"
        )

    seen = set()
    for account in accounts:
        if account.name in seen:
            raise SystemExit(f"PayPal 账号名称重复：{account.name}")
        seen.add(account.name)
        if not account.client_id:
            raise SystemExit(f"PayPal 账号 {account.name} 缺少 client_id")
        if not account.client_secret:
            raise SystemExit(f"PayPal 账号 {account.name} 缺少 client_secret")
    return accounts


def load_paypal_accounts() -> List[PayPalAccount]:
    """Load all configured accounts.

    Preferred formats:
    - PAYPAL_ACCOUNTS_JSON=[{"name":"store_a","client_id":"...","client_secret":"...","proxy_url":"socks5h://..."}]
    - PAYPAL_ACCOUNT_KEYS=store_a,store_b with PAYPAL_STORE_A_CLIENT_ID / PAYPAL_STORE_A_PROXY_URL etc.

    Legacy PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET remains supported as a single default account.
    """

    raw_json = (os.getenv("PAYPAL_ACCOUNTS_JSON") or "").strip()
    if raw_json:
        return _validate_accounts(_load_accounts_from_json(raw_json))

    raw_keys = (os.getenv("PAYPAL_ACCOUNT_KEYS") or "").strip()
    if raw_keys:
        return _validate_accounts(_load_accounts_from_keys(raw_keys))

    return _validate_accounts(_load_legacy_account())


def select_paypal_accounts(selected: str = "") -> List[PayPalAccount]:
    accounts = load_paypal_accounts()
    names = [x.strip() for x in selected.split(",") if x.strip()]
    if not names:
        return accounts

    by_name: Dict[str, PayPalAccount] = {account.name: account for account in accounts}
    missing = [name for name in names if name not in by_name]
    if missing:
        raise SystemExit(f"未找到指定 PayPal 账号：{','.join(missing)}；可用账号：{','.join(by_name)}")
    return [by_name[name] for name in names]


def make_paypal_session(account: PayPalAccount) -> requests.Session:
    session = requests.Session()
    if account.proxy_url:
        _ensure_supported_proxy(account.proxy_url)
        session.proxies.update({"http": account.proxy_url, "https": account.proxy_url})
        # Explicit per-account proxy should not be overridden by host HTTP(S)_PROXY env vars.
        session.trust_env = False
    return session


def _ensure_supported_proxy(proxy_url: str) -> None:
    scheme = urlsplit(proxy_url).scheme.lower()
    if not scheme.startswith("socks"):
        return
    try:
        import socks  # noqa: F401
    except ImportError as exc:
        raise SystemExit(
            "当前环境未安装 SOCKS 代理依赖；请先执行 pip install -r jobs/requirements.txt "
            "或 pip install 'requests[socks]'"
        ) from exc


def fetch_account_egress_ip(account: PayPalAccount, timeout: float = 30.0) -> str:
    """Return the public egress IP observed through the account's configured proxy."""
    url = (os.getenv("PAYPAL_PROXY_IP_CHECK_URL") or DEFAULT_IP_ECHO_URL).strip()
    session = make_paypal_session(account)
    response = session.get(url, timeout=max(1.0, timeout))
    response.raise_for_status()

    try:
        data = response.json()
    except ValueError:
        return response.text.strip()

    if isinstance(data, dict):
        ip = str(data.get("ip") or data.get("origin") or "").strip()
        if ip:
            return ip
    return response.text.strip()


def mask_proxy_url(proxy_url: Optional[str]) -> str:
    raw = (proxy_url or "").strip()
    if not raw:
        return "-"
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return "***"

    if not parsed.netloc:
        return "***"
    host = parsed.hostname or ""
    port = f":{parsed.port}" if parsed.port else ""
    auth = "***:***@" if parsed.username or parsed.password else ""
    return urlunsplit((parsed.scheme, f"{auth}{host}{port}", parsed.path, "", ""))
