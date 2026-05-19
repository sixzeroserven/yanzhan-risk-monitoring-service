"""
Check the actual egress IP for configured PayPal account proxies.

This script uses the same PayPal account/proxy loader as the PayPal sync jobs,
then requests an external IP echo endpoint through each account's Session.
"""

from __future__ import annotations

import argparse
import logging
import sys

import requests
from dotenv import load_dotenv
from paypal_accounts import fetch_account_egress_ip, mask_proxy_url, select_paypal_accounts

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(description="Check PayPal proxy egress IP")
    parser.add_argument(
        "--paypal-account",
        default="",
        help="只检查指定 PayPal 账号名；多个用逗号分隔。默认检查全部配置账号",
    )
    parser.add_argument(
        "--url",
        default="",
        help="IP echo URL；不传时使用 PAYPAL_PROXY_IP_CHECK_URL 或默认 https://api.ipify.org?format=json",
    )
    parser.add_argument("--timeout", type=float, default=30.0, help="请求超时秒数")
    args = parser.parse_args()

    ok = True
    for account in select_paypal_accounts(args.paypal_account):
        if args.url:
            import os

            os.environ["PAYPAL_PROXY_IP_CHECK_URL"] = args.url
        logger.info(
            "检查代理出口：account=%s proxy=%s url=%s",
            account.name,
            mask_proxy_url(account.proxy_url),
            args.url or "https://api.ipify.org?format=json",
        )
        try:
            ip = fetch_account_egress_ip(account, timeout=args.timeout)
        except requests.RequestException as exc:
            ok = False
            logger.error("账号 %s 代理检查失败：%s", account.name, exc)
            continue

        logger.info("账号 %s 出口 IP：%s", account.name, ip or "-")

    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
