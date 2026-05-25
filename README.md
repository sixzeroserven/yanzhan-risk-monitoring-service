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
- `jobs/sync_paypal_disputes.py`：从 PayPal Disputes API 同步争议数据到库表 `paypal_disputes`，单账号可配置 **`PAYPAL_CLIENT_ID`**、**`PAYPAL_CLIENT_SECRET`**（可选 `PAYPAL_BASE_URL`、`PAYPAL_PROXY_URL`）。多 PayPal 账号可配置 `PAYPAL_ACCOUNTS_JSON` 或 `PAYPAL_ACCOUNT_KEYS`，每个账号独立 `proxy_url`，OAuth/Disputes API 都走该账号自己的静态住宅代理。  
- `jobs/sync_paypal_reporting_transactions.py`：从 PayPal Reporting Transaction Search（`/v1/reporting/transactions`）按 T 码拉取交易并写入 `paypal_reporting_transactions`；与 disputes 共用同一套 PayPal 多账号/代理配置。可选环境变量见 `.env.example` 中 `PAYPAL_REPORTING_*`（分页、T 码集合、回溯上限、HTTP 超时与重试）。建表见 `sql/init.sql` 或 `npx prisma db push`。  
- `jobs/import_transaction_ids_from_excel.py`：从 Excel 表头匹配「A端订单号 / 订单编号」与「平台订单号 / 交易号」，按 `order_id` 更新 `transaction_id`（依赖 `openpyxl`，见 `jobs/requirements.txt`）。用法：`python3 jobs/import_transaction_ids_from_excel.py --excel /path/to/file.xlsx`。  

示例变量见 `.env.example` / `.env.docker.example`。容器内执行脚本前请确认同一 `.env` 已包含上述变量（`docker compose` 的 `env_file` 会注入到 `app` 服务）。  

PayPal 同步示例：

```bash
# 默认同步所有已配置 PayPal 账号；每个账号使用自己的 proxy_url / PAYPAL_xxx_PROXY_URL。
python3 jobs/sync_paypal_disputes.py
python3 jobs/sync_paypal_disputes.py --start-time 2026-05-01T00:00:00Z --end-time 2026-05-11T00:00:00Z --fetch-detail
python3 jobs/sync_paypal_disputes.py --dry-run
python3 jobs/sync_paypal_disputes.py --paypal-account paypal_a

python3 jobs/check_paypal_proxy_ip.py --paypal-account paypal_a

python3 jobs/sync_paypal_reporting_transactions.py
python3 jobs/sync_paypal_reporting_transactions.py --lookback-days 30 --dry-run
python3 jobs/sync_paypal_reporting_transactions.py --max-backfill-days 1095
python3 jobs/sync_paypal_reporting_transactions.py --paypal-account paypal_a,paypal_b
```

多 PayPal 账号代理配置示例：

```bash
PAYPAL_ACCOUNTS_JSON='[
  {"name":"paypal_a","client_id":"client_id_a","client_secret":"client_secret_a","proxy_url":"socks5h://proxy_user_a:proxy_password_a@proxy-a.example:12345"},
  {"name":"paypal_b","client_id":"client_id_b","client_secret":"client_secret_b","proxy_url":"socks5h://proxy_user_b:proxy_password_b@proxy-b.example:12345"}
]'
```

也可以使用 `PAYPAL_ACCOUNT_KEYS=paypal_a,paypal_b`，再分别配置 `PAYPAL_PAYPAL_A_CLIENT_ID`、`PAYPAL_PAYPAL_A_CLIENT_SECRET`、`PAYPAL_PAYPAL_A_PROXY_URL` 等分项变量。

SOCKS5 代理建议写成 `socks5h://user:password@host:port`，这样域名解析也会通过代理完成；依赖已在 `jobs/requirements.txt` 中改为 `requests[socks]`，部署时重新执行 `pip install -r jobs/requirements.txt` 或重建 Docker 镜像即可。

Reporting API 若返回 `RATE_LIMIT_REACHED` / HTTP 429，脚本会自动按 `Retry-After` 或指数退避重试；默认每次 Reporting GET 前等待 `PAYPAL_REPORTING_REQUEST_DELAY_SECONDS=1` 秒，429 最多尝试 `PAYPAL_REPORTING_RATE_LIMIT_RETRIES=8` 次，可在 `.env` 中调大等待时间。

Disputes API 通过代理偶发 `ReadTimeout` 或 429 时也会自动重试，默认 `PAYPAL_DISPUTE_HTTP_READ_TIMEOUT=120`、`PAYPAL_DISPUTE_HTTP_RETRIES=8`；详情接口默认每条间隔 `PAYPAL_DISPUTE_DETAIL_DELAY_SECONDS=2` 秒，且 `PAYPAL_DISPUTE_DETAIL_HTTP_RETRIES=1`、`PAYPAL_DISPUTE_DETAIL_READ_TIMEOUT=30`，也就是详情接口单条超时/429 会立即记录到 `PAYPAL_DISPUTE_DETAIL_FAILED_LOG` 并跳过该 dispute_id，保留列表接口数据继续同步，不会让整个账号任务直接中断；所有失败 dispute_id 会在日志中完整分批打印。

争议 ID 很多时不要改代码里的 `BUILTIN_DISPUTE_IDS_BACKFILL`，可以维护一个文本文件：

```bash
docker compose exec app python3 jobs/sync_paypal_disputes.py \
  --paypal-account paypal_207_228_203_72 \
  --dispute-ids-file jobs/dispute_ids.txt
```

文件格式支持每行一个、逗号分隔和 `#` 注释，示例见 `jobs/dispute_ids.example.txt`。

## 部署到 Azure 虚拟机

仓库提供两个脚本：

- `scripts/azure-vm-bootstrap.sh`：在虚拟机上初始化 Docker 环境（一次性）  
- `scripts/azure-vm-deploy.sh`：打包上传项目、执行 `docker compose up -d --build`，并按脚本逻辑处理数据库（如 `prisma db push` 等，以脚本实际内容为准）  
- `scripts/azure-vm-enable-https.sh`：为已解析到 VM 的域名安装 Let’s Encrypt 证书并启用 HTTPS  

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

### 6）启用 HTTPS（域名就绪后）

确认域名 A 记录已解析到 VM 公网 IP，并且 Azure 网络安全组已放行 `80`、`443` 后执行：

```bash
./scripts/azure-vm-enable-https.sh <ssh_user> <vm_ip> <domain> [ssh_key_path] [certbot_email]
```

示例：

```bash
./scripts/azure-vm-enable-https.sh azureuser 20.6.132.23 yanzhan.eu.cc ~/.ssh/id_rsa
```

完成后访问：

- `https://<domain>/health`
- `https://<domain>/docs`

### 安全说明

- 应用容器仅监听 `127.0.0.1:3000`，由宿主机 Nginx 在 `80` 端口反向代理对外访问。  
- HTTPS 由宿主机 Nginx 和 Let’s Encrypt（`certbot`）处理，证书会通过 `certbot.timer` 自动续期。  

## 定时任务模块

应用内置 Nest 定时任务，默认每日 **`01:00`** 执行：

- Cron：`0 1 * * *`  
- 命令：`python3 jobs/crawl_orders.py`  
- 代码：`src/scheduler/scheduler.service.ts`  

脚本路径：`jobs/crawl_orders.py`（请确保 `.env` 中已配置 **`DIANXIAOMI_COOKIE`**）。  

##在docker中执行脚本docker compose exec app python3 + .....
## ssh azureuser@20.6.132.23
./scripts/azure-vm-deploy.sh