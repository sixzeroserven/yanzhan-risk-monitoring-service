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

## Scheduled Job Module

The app includes a built-in Nest scheduler module that runs daily at `01:00`:

- Cron: `0 1 * * *`
- Command: `python3 jobs/crawl_orders.py`
- Scheduler code: `src/scheduler/scheduler.service.ts`

Put your script at:

- `jobs/crawl_orders.py`
