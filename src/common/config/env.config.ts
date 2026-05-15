import { Injectable } from "@nestjs/common";
import * as dotenv from "dotenv";

dotenv.config();

export type ShoplazzaStoreConfig = {
  storeDomain: string;
  adminToken: string;
  webhookSecret: string;
};

export type ShoplazzaGlobalConfig = {
  timeoutMs: number;
  insecureTls: boolean;
  autoSubscribeWebhook: boolean;
  apiVersion: string;
  subscribeWebhookPathTemplate: string;
  webhookCallbackUrl: string;
  cancelOrderPathTemplate: string;
  updateOrderPathTemplate: string;
};

@Injectable()
export class EnvConfig {
  constructor() {
    const required = ["PORT", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"];
    for (const key of required) {
      if (!process.env[key]) throw new Error(`缺少必填环境变量：${key}`);
    }

    const hasSingleStore =
      !!process.env.SHOPLAZZA_STORE_DOMAIN &&
      !!process.env.SHOPLAZZA_ADMIN_TOKEN &&
      !!process.env.SHOPLAZZA_WEBHOOK_SECRET;
    const rawWebhookStores = (process.env.SHOPLAZZA_WEBHOOK_STORES_JSON || "").trim();
    const rawLegacyStores = (process.env.SHOPLAZZA_STORES_JSON || "").trim();
    const hasMultiStore =
      this.hasValidShoplazzaStoresJson(rawWebhookStores) || this.hasValidShoplazzaStoresJson(rawLegacyStores);

    if (!hasSingleStore && !hasMultiStore) {
      throw new Error(
        "缺少 Shoplazza 店铺配置。请配置 SHOPLAZZA_WEBHOOK_STORES_JSON（或兼容项 SHOPLAZZA_STORES_JSON），或配置单店铺变量（SHOPLAZZA_STORE_DOMAIN + SHOPLAZZA_ADMIN_TOKEN + SHOPLAZZA_WEBHOOK_SECRET）。"
      );
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
      insecureTls: String(process.env.SHOPLAZZA_INSECURE_TLS || "false") === "true",
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

  get shoplazzaStores(): ShoplazzaStoreConfig[] {
    const fallbackStore: ShoplazzaStoreConfig = {
      storeDomain: process.env.SHOPLAZZA_STORE_DOMAIN as string,
      adminToken: process.env.SHOPLAZZA_ADMIN_TOKEN as string,
      webhookSecret: process.env.SHOPLAZZA_WEBHOOK_SECRET as string
    };

    const rawWebhook = (process.env.SHOPLAZZA_WEBHOOK_STORES_JSON || "").trim();
    const fromWebhook = this.tryParseShoplazzaStoresJson(rawWebhook);
    if (fromWebhook.length > 0) return fromWebhook;

    const rawLegacy = (process.env.SHOPLAZZA_STORES_JSON || "").trim();
    const fromLegacy = this.tryParseShoplazzaStoresJson(rawLegacy);
    if (fromLegacy.length > 0) return fromLegacy;

    return [fallbackStore];
  }

  get shoplazzaGlobal(): ShoplazzaGlobalConfig {
    const config = this.shoplazza;
    return {
      timeoutMs: config.timeoutMs,
      insecureTls: config.insecureTls,
      autoSubscribeWebhook: config.autoSubscribeWebhook,
      apiVersion: config.apiVersion,
      subscribeWebhookPathTemplate: config.subscribeWebhookPathTemplate,
      webhookCallbackUrl: config.webhookCallbackUrl,
      cancelOrderPathTemplate: config.cancelOrderPathTemplate,
      updateOrderPathTemplate: config.updateOrderPathTemplate
    };
  }

  findShoplazzaStore(storeDomain?: string): ShoplazzaStoreConfig {
    const stores = this.shoplazzaStores;
    const normalized = String(storeDomain || "")
      .trim()
      .toLowerCase();
    if (!normalized) return stores[0];
    return (
      stores.find((item) => item.storeDomain.toLowerCase() === normalized) ||
      stores.find((item) => normalized.includes(item.storeDomain.toLowerCase())) ||
      stores[0]
    );
  }

  private hasValidShoplazzaStoresJson(raw: string): boolean {
    return this.tryParseShoplazzaStoresJson(raw).length > 0;
  }

  /** 解析多店铺 JSON；无效或空则返回 []（不抛错）。 */
  private tryParseShoplazzaStoresJson(raw: string): ShoplazzaStoreConfig[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const stores = parsed
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const row = item as Record<string, unknown>;
          const storeDomain = String(row.storeDomain || row.store_domain || "").trim();
          const adminToken = String(row.adminToken || row.admin_token || "").trim();
          const webhookSecret = String(row.webhookSecret || row.webhook_secret || "").trim();
          if (!storeDomain || !adminToken || !webhookSecret) return null;
          return { storeDomain, adminToken, webhookSecret };
        })
        .filter(Boolean) as ShoplazzaStoreConfig[];
      return stores;
    } catch {
      return [];
    }
  }
}
