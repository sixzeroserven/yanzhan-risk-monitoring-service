#!/usr/bin/env bash

set -euo pipefail

# Optional local defaults file (do not commit your secrets).
DEFAULTS_FILE="./scripts/azure-vm-deploy.local.env"
if [[ -f "${DEFAULTS_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${DEFAULTS_FILE}"
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: $0 [ssh_user] [vm_ip] [domain] [ssh_key_path] [certbot_email]"
  echo "支持通过环境变量或 ${DEFAULTS_FILE} 提供默认值："
  echo "  DEPLOY_SSH_USER, DEPLOY_VM_IP, DEPLOY_DOMAIN, DEPLOY_SSH_KEY_PATH, CERTBOT_EMAIL"
  echo "示例: DEPLOY_SSH_USER=azureuser DEPLOY_VM_IP=20.6.132.23 DEPLOY_DOMAIN=yanzhan.eu.cc DEPLOY_SSH_KEY_PATH=~/.ssh/id_rsa $0"
  exit 0
fi

SSH_USER="${1:-${DEPLOY_SSH_USER:-}}"
VM_IP="${2:-${DEPLOY_VM_IP:-}}"
DOMAIN="${3:-${DEPLOY_DOMAIN:-}}"
SSH_KEY_PATH="${4:-${DEPLOY_SSH_KEY_PATH:-}}"
CERTBOT_EMAIL="${5:-${CERTBOT_EMAIL:-}}"

if [[ -z "${SSH_USER}" || -z "${VM_IP}" || -z "${DOMAIN}" ]]; then
  echo "缺少参数。"
  echo "用法: $0 [ssh_user] [vm_ip] [domain] [ssh_key_path] [certbot_email]"
  exit 1
fi

if [[ ! "${DOMAIN}" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "域名格式不合法: ${DOMAIN}"
  exit 1
fi

if [[ "${SSH_KEY_PATH}" == "~/"* ]]; then
  SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"
fi

SSH_OPTS="-o StrictHostKeyChecking=accept-new"
if [[ -n "${SSH_KEY_PATH}" ]]; then
  SSH_OPTS="${SSH_OPTS} -i ${SSH_KEY_PATH}"
fi

REMOTE="${SSH_USER}@${VM_IP}"
quote_for_remote_env() {
  printf "%q" "$1"
}

echo "==> 在 Azure VM 配置 Nginx 与 Let's Encrypt HTTPS: ${DOMAIN}"
ssh ${SSH_OPTS} "${REMOTE}" \
  "DOMAIN=$(quote_for_remote_env "${DOMAIN}") VM_IP=$(quote_for_remote_env "${VM_IP}") CERTBOT_EMAIL=$(quote_for_remote_env "${CERTBOT_EMAIL}") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

echo "==> 检查域名解析"
RESOLVED_IP="$(getent ahostsv4 "${DOMAIN}" | awk '{print $1; exit}' || true)"
if [[ -n "${RESOLVED_IP}" && "${RESOLVED_IP}" != "${VM_IP}" ]]; then
  echo "警告: ${DOMAIN} 当前解析到 ${RESOLVED_IP}，不是 ${VM_IP}。Let's Encrypt 可能会失败。"
fi

echo "==> 确认 Nginx 已安装"
sudo apt-get update
sudo apt-get install -y nginx

echo "==> 写入 HTTP 反向代理配置"
sudo tee /etc/nginx/sites-available/shoplazza-blacklist >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/shoplazza-blacklist /etc/nginx/sites-enabled/shoplazza-blacklist
sudo nginx -t
sudo systemctl reload nginx

echo "==> 安装 Certbot"
sudo apt-get install -y certbot python3-certbot-nginx

CERTBOT_ACCOUNT_ARGS=(--register-unsafely-without-email)
if [[ -n "${CERTBOT_EMAIL}" ]]; then
  CERTBOT_ACCOUNT_ARGS=(--email "${CERTBOT_EMAIL}")
fi

echo "==> 申请/安装证书并启用 HTTP 到 HTTPS 跳转"
sudo certbot --nginx \
  -d "${DOMAIN}" \
  --non-interactive \
  --agree-tos \
  "${CERTBOT_ACCOUNT_ARGS[@]}" \
  --redirect

echo "==> 确认自动续期定时器"
sudo systemctl enable --now certbot.timer
sudo systemctl list-timers certbot.timer --no-pager || true

echo "==> 验证 HTTPS"
curl -fsSIL --max-time 20 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/health" | sed -n '1,12p'
REMOTE_SCRIPT

echo "==> HTTPS 配置完成"
echo "访问地址: https://${DOMAIN}"
