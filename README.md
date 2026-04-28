# Shoplazza Blacklist Service (NestJS)

NestJS service using `@Controller` style APIs for:

- Shoplazza `orders/create` webhook interception
- blacklist checking API
- order save API
- Swagger docs

## Project Structure

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

## Run Locally

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run build
npm start
```

Startup log prints direct URLs:

- `http://localhost:3000/health`
- `http://localhost:3000/docs`
- `POST http://localhost:3000/api/blacklist/check`
- `POST http://localhost:3000/api/orders/save`

## Multi-Store Shoplazza Support

By default, the service works with one Shoplazza store using:

- `SHOPLAZZA_STORE_DOMAIN`
- `SHOPLAZZA_ADMIN_TOKEN`
- `SHOPLAZZA_WEBHOOK_SECRET`

To enable multiple stores, set `SHOPLAZZA_STORES_JSON` in `.env` as a JSON array:

```bash
SHOPLAZZA_STORES_JSON=[{"storeDomain":"store-a.myshoplaza.com","adminToken":"token_a","webhookSecret":"secret_a"},{"storeDomain":"store-b.myshoplaza.com","adminToken":"token_b","webhookSecret":"secret_b"}]
```

When `SHOPLAZZA_STORES_JSON` is provided, the service selects store config by webhook domain (header or payload), and falls back to the first configured store if missing.

## API Endpoints

- `GET /health`
- `POST /webhooks/shoplazza/orders/create`
- `POST /api/blacklist/check` (`@Controller("api/blacklist")`)
- `POST /api/orders/save` (`@Controller("api/orders")`)
- `POST /webhooks/shoplazza/orders/create` (`@Controller("webhooks/shoplazza/orders")`)

### Webhook Behavior

When an incoming `orders/create` webhook hits blacklist rules, the service:

- adds an order note in Shoplazza with hit rule types
- marks the order/customer as blacklisted by upserting `order_address` and `back_list`
- does **not** cancel the order automatically

### Save Order API

`POST /api/orders/save` will upsert into `order_address` by `order_id`.

If `save_blacklist=true`, it will also upsert into `back_list` (requires `package_number`).

## Docker Run

```bash
cp .env.docker.example .env
docker compose up -d --build
```

If local MySQL already occupies `3306`, this project maps container MySQL to host `3307`.

## Deploy to Azure VM

This repository includes two scripts for Azure Virtual Machine deployment:

- `scripts/azure-vm-bootstrap.sh`: initialize Docker environment on VM
- `scripts/azure-vm-deploy.sh`: upload project, run `docker compose up -d --build`, and execute `prisma db push`

### 1) Create Azure VM

- OS: Ubuntu 22.04 LTS
- Recommended size: 2 vCPU / 4GB RAM or above
- Open inbound ports: `22`, `80`, `443`
- Do not open `3000` to public network

### 2) Prepare local env

```bash
cp .env.docker.example .env
```

Edit `.env` with real values (database / multi-store tokens / webhook secrets).

### 3) Initialize VM once

```bash
./scripts/azure-vm-bootstrap.sh <ssh_user> <vm_ip> [ssh_key_path]
```

Example:

```bash
./scripts/azure-vm-bootstrap.sh azureuser 20.1.2.3 ~/.ssh/id_rsa
```

### 4) Deploy app to VM

```bash
./scripts/azure-vm-deploy.sh <ssh_user> <vm_ip> <remote_dir> [ssh_key_path]
```

Example:

```bash
./scripts/azure-vm-deploy.sh azureuser 20.1.2.3 /home/azureuser/shoplazza-blacklist-service ~/.ssh/id_rsa
```

### 5) Verify

- `http://<vm_ip>/health`
- `http://<vm_ip>/docs`

### Security Notes (No Domain Yet)

- App container is bound to `127.0.0.1:3000` only.
- Public access goes through Nginx on port `80`.
- Keep `443` open in NSG for future HTTPS migration.
- When domain is ready, add Let's Encrypt (`certbot`) and switch to HTTPS.

## Scheduled Job Module

The app includes a built-in Nest scheduler module that runs daily at `01:00`:

- Cron: `0 1 * * *`
- Command: `python3 jobs/crawl_orders.py`
- Scheduler code: `src/scheduler/scheduler.service.ts`

Put your script at:

- `jobs/crawl_orders.py`
