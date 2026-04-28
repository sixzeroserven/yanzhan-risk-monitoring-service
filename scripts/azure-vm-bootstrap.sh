#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "用法: $0 <ssh_user> <vm_ip> [ssh_key_path]"
  exit 1
fi

SSH_USER="$1"
VM_IP="$2"
SSH_KEY_PATH="${3:-}"

SSH_OPTS="-o StrictHostKeyChecking=accept-new"
if [[ -n "${SSH_KEY_PATH}" ]]; then
  SSH_OPTS="${SSH_OPTS} -i ${SSH_KEY_PATH}"
fi

REMOTE="${SSH_USER}@${VM_IP}"

echo "==> 在 Azure VM 安装 Docker、Docker Compose 和 Nginx"
ssh ${SSH_OPTS} "${REMOTE}" "
  set -euo pipefail
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg lsb-release
  sudo install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  fi
  echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \$(lsb_release -cs) stable\" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo apt-get install -y nginx
  sudo usermod -aG docker ${SSH_USER}
  sudo systemctl enable docker
  sudo systemctl restart docker
  sudo systemctl enable nginx
  sudo systemctl restart nginx
  docker --version
  docker compose version
  nginx -v
"

echo "==> VM 初始化完成"
echo "提示: 如果首次添加 docker 用户组后权限未生效，请重新 SSH 登录再执行部署脚本。"
