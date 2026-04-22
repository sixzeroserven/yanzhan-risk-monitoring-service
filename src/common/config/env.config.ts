import { Injectable } from "@nestjs/common";
import * as dotenv from "dotenv";

dotenv.config();

@Injectable()
export class EnvConfig {
  constructor() {
    const required = [
      "PORT",
      "DB_HOST",
      "DB_PORT",
      "DB_USER",
      "DB_PASSWORD",
      "DB_NAME",
      "SHOPLAZZA_STORE_DOMAIN",
      "SHOPLAZZA_ADMIN_TOKEN",
      "SHOPLAZZA_WEBHOOK_SECRET"
    ];
    for (const key of required) {
      if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  get port(): number {
    return Number(process.env.PORT);
  }
  get db() {
    return {
      host: process.env.DB_HOST as string,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER as string,
      password: process.env.DB_PASSWORD as string,
      database: process.env.DB_NAME as string,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10)
    };
  }
  get databaseUrl(): string {
    const user = encodeURIComponent(process.env.DB_USER as string);
    const password = encodeURIComponent(process.env.DB_PASSWORD as string);
    const host = process.env.DB_HOST as string;
    const port = Number(process.env.DB_PORT);
    const database = process.env.DB_NAME as string;
    return `mysql://${user}:${password}@${host}:${port}/${database}`;
  }
  get shoplazza() {
    return {
      storeDomain: process.env.SHOPLAZZA_STORE_DOMAIN as string,
      adminToken: process.env.SHOPLAZZA_ADMIN_TOKEN as string,
      webhookSecret: process.env.SHOPLAZZA_WEBHOOK_SECRET as string,
      timeoutMs: Number(process.env.SHOPLAZZA_TIMEOUT_MS || 10000),
      autoSubscribeWebhook: String(process.env.SHOPLAZZA_AUTO_SUBSCRIBE_WEBHOOK || "false") === "true",
      apiVersion: process.env.SHOPLAZZA_API_VERSION || "2020-07",
      subscribeWebhookPathTemplate:
        process.env.SHOPLAZZA_SUBSCRIBE_WEBHOOK_PATH_TEMPLATE || "/openapi/{version}/webhooks/subscribe",
      webhookCallbackUrl: process.env.SHOPLAZZA_WEBHOOK_CALLBACK_URL || "",
      cancelOrderPathTemplate:
        process.env.SHOPLAZZA_CANCEL_ORDER_PATH_TEMPLATE ||
        "/admin/openapi/2020-07/orders/{orderId}/cancel.json",
      updateOrderPathTemplate:
        process.env.SHOPLAZZA_UPDATE_ORDER_PATH_TEMPLATE ||
        "/admin/openapi/2020-07/orders/{orderId}.json"
    };
  }
}
