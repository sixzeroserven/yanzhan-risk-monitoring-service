# Shoplazza 黑名单服务（NestJS）

基于 NestJS、`@Controller` 风格的接口服务，提供：

- Shoplazza `orders/create` Webhook 拦截与黑名单逻辑  
- 黑名单校验接口  
- 订单保存接口  
- Swagger 文档  

## 目录结构

```text
src
├── main.ts
├── app.module.ts
├── health.controller.ts
├── common
│   ├── config/env.config.ts
│   └── utils/normalize.util.ts
├── database
│   ├── database.module.ts
│   └── database.service.ts
├── prisma
│   └── schema.prisma
├── blacklist
│   ├── blacklist.module.ts
│   ├── blacklist.controller.ts
│   └── blacklist.service.ts
├── orders
│   ├── orders.module.ts
│   ├── orders.controller.ts
│   └── orders.service.ts
├── shoplazza
│   ├── shoplazza.module.ts
│   └── shoplazza.service.ts
├── scheduler
│   ├── scheduler.module.ts
│   └── scheduler.service.ts
└── webhooks
    ├── webhooks.module.ts
    ├── webhooks.controller.ts
    └── webhooks.service.ts
```

## 本地运行

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run build
npm start
```

启动后可直接访问：

- `http://localhost:3000/health`
- `http://localhost:3000/docs`
- `POST http://localhost:3000/api/blacklist/check`
- `POST http://localhost:3000/api/orders/save`

## 多店铺 Shoplazza

默认使用单个店铺，环境变量：

- `SHOPLAZZA_STORE_DOMAIN`
- `SHOPLAZZA_ADMIN_TOKEN`
- `SHOPLAZZA_WEBHOOK_SECRET`

多店铺时在 `.env` 中设置 `SHOPLAZZA_STORES_JSON`（JSON 数组），例如：

```bash
SHOPLAZZA_STORES_JSON=[{"storeDomain":"store-a.myshoplaza.com","adminToken":"token_a","webhookSecret":"secret_a"},{"storeDomain":"store-b.myshoplaza.com","adminToken":"token_b","webhookSecret":"secret_b"}]
```

配置 `SHOPLAZZA_STORES_JSON` 后，服务按 Webhook 里的店铺域名匹配配置；缺失时回退到数组中的第一项。

## 接口说明

- `GET /health`：健康检查  
- `POST /webhooks/shoplazza/orders/create`：订单创建 Webhook  
- `POST /api/blacklist/check`：黑名单校验（控制器前缀 `api/blacklist`）  
- `POST /api/orders/save`：保存订单（控制器前缀 `api/orders`）  

### Webhook 行为

当 `orders/create`（或订单更新流程）命中黑名单规则时，服务会：

- 在 Shoplazza 订单中追加备注（命中规则类型）  
- 通过写入 `order_address` 与黑名单相关数据标记风险  
- **不会**自动取消订单  

### 保存订单接口

`POST /api/orders/save` 按 `order_id` 对 `order_address` 做 upsert。  

若 `save_blacklist=true`，还会写入黑名单相关表（需提供 `package_number` 等必填字段）。  

## Docker 运行

```bash
cp .env.docker.example .env
docker compose up -d --build
```

若本机已有服务占用 `3306`，可将 compose 中 MySQL 映射改为例如宿主机的 `3307`（按你本地 `docker-compose.yml` 为准）。  

## Python 定时任务与凭证

- `jobs/crawl_orders.py`：抓取店小秘订单，需在 `.env` 中配置 **`DIANXIAOMI_COOKIE`**（浏览器登录店小秘后复制完整 Cookie）。  
- `jobs/sync_hipay_transaction_ids.py`：从 Hipay 同步交易号到库表 `transaction_id`，需配置 **`HIPAY_AUTHORIZATION`**（完整 `Bearer …` 字符串）。  

示例变量见 `.env.example` / `.env.docker.example`。容器内执行脚本前请确认同一 `.env` 已包含上述变量（`docker compose` 的 `env_file` 会注入到 `app` 服务）。  

## 部署到 Azure 虚拟机

仓库提供两个脚本：

- `scripts/azure-vm-bootstrap.sh`：在虚拟机上初始化 Docker 环境（一次性）  
- `scripts/azure-vm-deploy.sh`：打包上传项目、执行 `docker compose up -d --build`，并按脚本逻辑处理数据库（如 `prisma db push` 等，以脚本实际内容为准）  

### 1）创建虚拟机

- 系统：Ubuntu 22.04 LTS  
- 建议规格：2 vCPU / 4GB 内存或以上  
- 入站端口：`22`、`80`、`443`  
- **不要**把应用端口 `3000` 直接暴露到公网（由 Nginx 反代）  

### 2）准备本地环境文件

```bash
cp .env.docker.example .env
```

按实际数据库、多店铺 Token、Webhook 密钥等编辑 `.env`。  

### 3）初始化虚拟机（首次）

```bash
./scripts/azure-vm-bootstrap.sh <ssh_user> <vm_ip> [ssh_key_path]
```

示例：

```bash
./scripts/azure-vm-bootstrap.sh azureuser 20.1.2.3 ~/.ssh/id_rsa
```

### 4）部署应用到虚拟机

```bash
./scripts/azure-vm-deploy.sh <ssh_user> <vm_ip> <remote_dir> [ssh_key_path]
```

也可配合 `scripts/azure-vm-deploy.local.env` 减少重复参数（脚本支持读取该文件）。  

### 5）验证

- `http://<vm_ip>/health`  
- `http://<vm_ip>/docs`  

### 安全说明（暂无独立域名时）

- 应用容器仅监听 `127.0.0.1:3000`，由宿主机 Nginx 在 `80` 端口反向代理对外访问。  
- 网络安全组可保留 `443` 开放，便于后续接入 HTTPS。  
- 域名就绪后建议使用 Let’s Encrypt（`certbot`）等切换为 HTTPS。  

## 定时任务模块

应用内置 Nest 定时任务，默认每日 **`01:00`** 执行：

- Cron：`0 1 * * *`  
- 命令：`python3 jobs/crawl_orders.py`  
- 代码：`src/scheduler/scheduler.service.ts`  

脚本路径：`jobs/crawl_orders.py`（请确保 `.env` 中已配置 **`DIANXIAOMI_COOKIE`**）。  
