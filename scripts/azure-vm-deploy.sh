#!/usr/bin/env bash

set -euo pipefail

# Optional local defaults file (do not commit your secrets).
DEFAULTS_FILE="./scripts/azure-vm-deploy.local.env"
if [[ -f "${DEFAULTS_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${DEFAULTS_FILE}"
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "用法: $0 [ssh_user] [vm_ip] [remote_dir] [ssh_key_path] [--run-db-push]"
  echo "支持通过环境变量或 ${DEFAULTS_FILE} 提供默认值："
  echo "  DEPLOY_SSH_USER, DEPLOY_VM_IP, DEPLOY_REMOTE_DIR, DEPLOY_SSH_KEY_PATH"
  echo "示例(最短): DEPLOY_SSH_USER=azureuser DEPLOY_VM_IP=20.1.2.3 DEPLOY_REMOTE_DIR=/home/azureuser/shoplazza-blacklist-service DEPLOY_SSH_KEY_PATH=~/.ssh/id_rsa $0"
  echo "示例(危险): $0 --run-db-push"
  exit 0
fi

RUN_DB_PUSH="false"
POSITIONAL_ARGS=()
for arg in "$@"; do
  if [[ "${arg}" == "--run-db-push" ]]; then
    RUN_DB_PUSH="true"
  else
    POSITIONAL_ARGS+=("${arg}")
  fi
done

SSH_USER="${POSITIONAL_ARGS[0]:-${DEPLOY_SSH_USER:-}}"
VM_IP="${POSITIONAL_ARGS[1]:-${DEPLOY_VM_IP:-}}"
REMOTE_DIR="${POSITIONAL_ARGS[2]:-${DEPLOY_REMOTE_DIR:-}}"
SSH_KEY_PATH="${POSITIONAL_ARGS[3]:-${DEPLOY_SSH_KEY_PATH:-}}"

if [[ -z "${SSH_USER}" || -z "${VM_IP}" || -z "${REMOTE_DIR}" ]]; then
  echo "缺少参数。"
  echo "用法: $0 [ssh_user] [vm_ip] [remote_dir] [ssh_key_path] [--run-db-push]"
  echo "你也可以先 export DEPLOY_SSH_USER / DEPLOY_VM_IP / DEPLOY_REMOTE_DIR / DEPLOY_SSH_KEY_PATH"
  exit 1
fi

if [[ ${#POSITIONAL_ARGS[@]} -gt 4 ]]; then
  echo "参数过多，仅支持 [ssh_user] [vm_ip] [remote_dir] [ssh_key_path] [--run-db-push]"
  exit 1
fi

if [[ "${SSH_KEY_PATH}" == "~/"* ]]; then
  SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"
fi

if [[ ! -f ".env" ]]; then
  echo "当前目录缺少 .env，请先准备好生产环境变量。"
  exit 1
fi

SSH_OPTS="-o StrictHostKeyChecking=accept-new"
SCP_OPTS="-o StrictHostKeyChecking=accept-new"
if [[ -n "${SSH_KEY_PATH}" ]]; then
  SSH_OPTS="${SSH_OPTS} -i ${SSH_KEY_PATH}"
  SCP_OPTS="${SCP_OPTS} -i ${SSH_KEY_PATH}"
fi

REMOTE="${SSH_USER}@${VM_IP}"
TMP_TAR="/tmp/shoplazza-blacklist-service.tar.gz"

echo "==> 打包项目并上传到 Azure VM"
tar --exclude=".git" --exclude="node_modules" --exclude="dist" --exclude="logs" -czf "${TMP_TAR}" .
scp ${SCP_OPTS} "${TMP_TAR}" "${REMOTE}:/tmp/shoplazza-blacklist-service.tar.gz"
rm -f "${TMP_TAR}"

echo "==> 在 Azure VM 解压并启动容器"
ssh ${SSH_OPTS} "${REMOTE}" "
  set -euo pipefail
  mkdir -p '${REMOTE_DIR}'
  tar -xzf /tmp/shoplazza-blacklist-service.tar.gz -C '${REMOTE_DIR}'
  rm -f /tmp/shoplazza-blacklist-service.tar.gz
  cd '${REMOTE_DIR}'
  docker compose down || true
  docker compose up -d --build
  if [[ -d prisma/migrations ]] && [[ \"\$(ls -A prisma/migrations 2>/dev/null)\" != \"\" ]]; then
    echo '==> 执行 Prisma 迁移: prisma migrate deploy'
    docker compose exec -T app npx prisma migrate deploy
  else
    echo '==> 未检测到 prisma/migrations，跳过 prisma migrate deploy'
  fi
  if [[ '${RUN_DB_PUSH}' == 'true' ]]; then
    echo '==> 警告: 正在执行 prisma db push（可能会删除现有表/字段）'
    docker compose exec -T app npx prisma db push --accept-data-loss
  else
    echo '==> 安全模式: 默认不执行 prisma db push'
  fi
  docker compose ps

  sudo tee /etc/nginx/sites-available/shoplazza-blacklist >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name _;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
    }
}
EOF

  sudo rm -f /etc/nginx/sites-enabled/default
  sudo ln -sfn /etc/nginx/sites-available/shoplazza-blacklist /etc/nginx/sites-enabled/shoplazza-blacklist
  sudo nginx -t
  sudo systemctl reload nginx
"

echo "==> 部署完成"
echo "健康检查: http://${VM_IP}/health"
