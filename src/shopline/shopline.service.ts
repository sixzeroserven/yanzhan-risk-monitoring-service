import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import * as crypto from "crypto";
import * as https from "https";

export type ShoplineStoreConfig = {
  storeDomain: string;
  accessToken: string;
  webhookSecret: string;
  orderIdPrefix?: string;
};

@Injectable()
export class ShoplineService implements OnModuleInit {
  private readonly logger = new Logger(ShoplineService.name);

  async onModuleInit(): Promise<void> {
    if (!this.autoSubscribeWebhook()) return;
    for (const store of this.shoplineStores()) {
      try {
        const result = await this.ensureOrderWebhook("orders/create", store.storeDomain);
        this.logger.log(
          `自动订阅 Shopline webhook 成功：store=${store.storeDomain} event=${result.topic} callback=${result.callback_url}`
        );
      } catch (error) {
        this.logger.error(
          `自动订阅 Shopline webhook 失败：store=${store.storeDomain} topic=orders/create ${this.formatAxiosError(error)}`
        );
      }
    }
  }

  resolveVerifiedStoreDomain(rawBody: Buffer, providedSignature?: string, storeDomain?: string): string | undefined {
    if (!providedSignature || !rawBody) return undefined;
    const preferredStore = this.findShoplineStore(storeDomain);
    if (this.verifyHmacBySecret(rawBody, providedSignature, preferredStore.webhookSecret)) {
      return preferredStore.storeDomain;
    }

    for (const store of this.shoplineStores()) {
      if (store.storeDomain === preferredStore.storeDomain) continue;
      if (this.verifyHmacBySecret(rawBody, providedSignature, store.webhookSecret)) {
        this.logger.warn(
          `Shopline webhook 验签已通过回退匹配：requestedStore=${storeDomain || "-"} matchedStore=${store.storeDomain}`
        );
        return store.storeDomain;
      }
    }
    return undefined;
  }

  findShoplineStore(storeDomain?: string): ShoplineStoreConfig {
    const stores = this.shoplineStores();
    if (stores.length === 0) {
      throw new BadRequestException("缺少 Shopline 店铺配置");
    }
    const normalized = String(storeDomain || "").trim().toLowerCase();
    if (!normalized) return stores[0];
    return (
      stores.find((item) => item.storeDomain.toLowerCase() === normalized) ||
      stores.find((item) => normalized.includes(item.storeDomain.toLowerCase())) ||
      stores[0]
    );
  }

  async subscribeOrderCreateWebhook(callbackUrl?: string, storeDomain?: string) {
    return this.subscribeOrderWebhook("orders/create", callbackUrl, storeDomain);
  }

  async subscribeOrderWebhook(topic: string, callbackUrl?: string, storeDomain?: string) {
    const address = this.resolveCallbackUrl(topic, callbackUrl);
    if (!address) {
      throw new BadRequestException(
        "缺少 callback_url。请配置 SHOPLINE_WEBHOOK_CALLBACK_URL，或在请求体中传入 callback_url。"
      );
    }

    const path = this.webhookCollectionPath();
    const client = this.client(storeDomain);
    const payloads = this.buildSubscribePayloads(address, topic);
    let lastError: unknown;
    for (const payload of payloads) {
      try {
        const resp = await client.post(path, payload);
        return {
          success: true,
          topic,
          callback_url: address,
          api_path: path,
          payload,
          data: resp.data
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new BadRequestException(`订阅 Shopline webhook 请求被拒绝。${this.formatAxiosError(lastError)}`);
  }

  async listWebhooks(storeDomain?: string) {
    const path = this.webhookCollectionPath();
    const resp = await this.client(storeDomain).get(path);
    const records = this.normalizeWebhookList(resp.data);
    return { api_path: path, count: records.length, records };
  }

  async cleanupWebhooks(keepTopics: string[] = ["orders/create"], storeDomain?: string) {
    const client = this.client(storeDomain);
    const keep = new Set(keepTopics.map((item) => item.trim()).filter(Boolean));
    const listed = await this.listWebhooks(storeDomain);
    const removed: Array<{ id: string; topic: string }> = [];
    const kept: Array<{ id: string; topic: string }> = [];

    for (const item of listed.records) {
      if (!item.id || keep.has(item.topic)) {
        kept.push({ id: item.id || "-", topic: item.topic || "-" });
        continue;
      }
      await client.delete(`${listed.api_path}/${encodeURIComponent(item.id)}`);
      removed.push({ id: item.id, topic: item.topic });
    }

    return {
      keepTopics: Array.from(keep),
      total: listed.records.length,
      removedCount: removed.length,
      keptCount: kept.length,
      removed,
      kept
    };
  }

  async ensureOrderWebhook(topic: string, storeDomain?: string) {
    const expectedAddress = this.resolveCallbackUrl(topic);
    const listed = await this.listWebhooks(storeDomain);
    const existing = listed.records.find((item) => item.topic === topic);
    if (existing && existing.address.trim() === expectedAddress.trim()) {
      return {
        success: true,
        topic,
        callback_url: existing.address,
        api_path: listed.api_path,
        data: existing
      };
    }

    if (existing?.id) {
      await this.client(storeDomain).delete(`${listed.api_path}/${encodeURIComponent(existing.id)}`);
      this.logger.warn(
        `检测到 Shopline webhook 回调地址不匹配，已删除旧订阅：store=${storeDomain || "-"} topic=${topic} old=${existing.address} expected=${expectedAddress}`
      );
    }
    return this.subscribeOrderWebhook(topic, expectedAddress, storeDomain);
  }

  async appendOrderNote(
    orderId: string | number,
    note: string,
    storeDomain?: string,
    existingNoteFromCaller?: string
  ): Promise<void> {
    const existingNote =
      existingNoteFromCaller === undefined
        ? await this.readExistingOrderNote(orderId, storeDomain)
        : this.pickFirstString(existingNoteFromCaller);
    if (this.hasNoteText(existingNote, note)) {
      this.logger.log(`Shopline 订单备注已存在：orderId=${String(orderId)}`);
      return;
    }

    const finalNote = existingNote ? `${existingNote}\n${note}` : note;
    const paths = this.orderWritePaths(orderId);
    const payloads: Array<Record<string, unknown>> = [
      { order: { id: orderId, note_attributes: [{ name: "risk_note", value: finalNote }] } },
      { order: { id: orderId, note: finalNote } },
      { order: { note: finalNote } },
      { note: finalNote },
      { remark: finalNote },
      { order: { remark: finalNote } }
    ];

    let lastError: unknown;
    for (const path of paths) {
      for (const payload of payloads) {
        try {
          await this.client(storeDomain).put(path, payload);
          this.logger.log(`Shopline 订单备注写入请求成功：orderId=${String(orderId)} writePath=${path}`);
          return;
        } catch (error) {
          lastError = error;
        }
      }
    }
    if (lastError) throw lastError;
    throw new Error("Shopline 备注写入失败：未知错误");
  }

  async getOrderReadback(orderId: string | number, storeDomain?: string): Promise<{
    order: Record<string, unknown>;
    usedPath: string;
    raw: Record<string, unknown>;
  }> {
    let lastError: unknown;
    for (const path of this.orderReadPaths(orderId)) {
      try {
        const resp = await this.client(storeDomain).get(path);
        const data = resp.data as Record<string, unknown>;
        const order = this.pickOrderObject(data);
        if (Object.keys(order).length > 0) {
          return { order, usedPath: path, raw: data };
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return { order: {}, usedPath: "", raw: {} };
  }

  private readExistingOrderNote(orderId: string | number, storeDomain?: string): Promise<string> {
    return this.getOrderReadback(orderId, storeDomain).then((readback) =>
      this.pickFirstString(readback.order.note, readback.order.order_note, readback.order.customer_note, readback.order.memo, readback.order.remark)
    );
  }

  private client(storeDomain?: string): AxiosInstance {
    const store = this.findShoplineStore(storeDomain);
    const httpsAgent = this.insecureTls() ? new https.Agent({ rejectUnauthorized: false }) : undefined;
    return axios.create({
      baseURL: `https://${store.storeDomain}`,
      timeout: Number(process.env.SHOPLINE_TIMEOUT_MS || 10000),
      httpsAgent,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${store.accessToken}`
      }
    });
  }

  private shoplineStores(): ShoplineStoreConfig[] {
    const fromWebhook = this.tryParseStoresJson(process.env.SHOPLINE_WEBHOOK_STORES_JSON || "", true);
    if (fromWebhook.length > 0) return fromWebhook;

    const fromLegacy = this.tryParseStoresJson(process.env.SHOPLINE_STORES_JSON || "", false);
    if (fromLegacy.length > 0) return fromLegacy;

    const domain = this.normalizeStoreDomain(
      process.env.SHOPLINE_STORE_DOMAIN || process.env.SHOPLINE_STORE_HANDLE || ""
    );
    const accessToken = String(process.env.SHOPLINE_ACCESS_TOKEN || "").trim();
    const webhookSecret = String(process.env.SHOPLINE_WEBHOOK_SECRET || "").trim();
    if (!domain || !accessToken) return [];
    return [
      {
        storeDomain: domain,
        accessToken,
        webhookSecret,
        orderIdPrefix: String(process.env.SHOPLINE_ORDER_ID_PREFIX || "").trim() || undefined
      }
    ];
  }

  private tryParseStoresJson(raw: string, requireWebhookSecret: boolean): ShoplineStoreConfig[] {
    const text = raw.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const row = item as Record<string, unknown>;
          const storeDomain = this.normalizeStoreDomain(
            String(row.storeDomain || row.store_domain || row.storeHost || row.store_host || "").trim()
          );
          const accessToken = String(
            row.accessToken || row.access_token || row.adminToken || row.admin_token || ""
          ).trim();
          const webhookSecret = String(row.webhookSecret || row.webhook_secret || "").trim();
          const orderIdPrefix = String(row.orderIdPrefix || row.order_id_prefix || "").trim() || undefined;
          if (!storeDomain || !accessToken) return null;
          if (requireWebhookSecret && !webhookSecret) return null;
          return { storeDomain, accessToken, webhookSecret, orderIdPrefix };
        })
        .filter(Boolean) as ShoplineStoreConfig[];
    } catch {
      return [];
    }
  }

  private normalizeStoreDomain(value: string): string {
    const domain = value.trim();
    if (!domain) return "";
    return domain.includes(".") ? domain : `${domain}.myshopline.com`;
  }

  private webhookCollectionPath(): string {
    return (process.env.SHOPLINE_WEBHOOKS_PATH_TEMPLATE || "/admin/openapi/{version}/webhooks.json").replace(
      "{version}",
      encodeURIComponent(this.apiVersion())
    );
  }

  private orderReadPaths(orderId: string | number): string[] {
    const collectionPath = `/admin/openapi/${encodeURIComponent(this.apiVersion())}/orders.json?ids=${encodeURIComponent(String(orderId))}`;
    return [collectionPath, this.orderPath(orderId)];
  }

  private orderWritePaths(orderId: string | number): string[] {
    return [this.orderPath(orderId)];
  }

  private orderPath(orderId: string | number): string {
    const template =
      process.env.SHOPLINE_UPDATE_ORDER_PATH_TEMPLATE ||
      "/admin/openapi/{version}/orders/{orderId}.json";
    return template
      .replace("{version}", encodeURIComponent(this.apiVersion()))
      .replace("{orderId}", encodeURIComponent(String(orderId)));
  }

  private buildSubscribePayloads(address: string, topic: string): Array<Record<string, unknown>> {
    return [
      { webhook: { address, api_version: this.apiVersion(), topic } },
      { webhook: { address, api_version: this.apiVersion(), event: topic } }
    ];
  }

  private resolveCallbackUrl(topic: string, callbackUrl?: string): string {
    const explicit = String(callbackUrl || "").trim();
    if (explicit) return explicit;
    const base = String(process.env.SHOPLINE_WEBHOOK_CALLBACK_URL || "").trim();
    if (!base) return "";
    const suffix = topic.split("/")[1] || "create";
    if (base.endsWith("/create") || base.endsWith("/update") || base.endsWith("/paid")) {
      const parts = base.split("/");
      parts[parts.length - 1] = suffix;
      return parts.join("/");
    }
    return base;
  }

  private normalizeWebhookList(data: unknown): Array<{ id: string; topic: string; address: string }> {
    const rows = this.pickWebhookArray(data);
    return rows
      .map((item) => {
        const row = item as Record<string, unknown>;
        const nested = row.webhook && typeof row.webhook === "object" ? (row.webhook as Record<string, unknown>) : row;
        return {
          id: String(nested.id || nested.webhook_id || nested.uuid || ""),
          topic: String(nested.topic || nested.event || ""),
          address: String(nested.address || nested.callback_url || nested.url || "")
        };
      })
      .filter((item) => item.id || item.topic || item.address);
  }

  private pickWebhookArray(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    const record = data as Record<string, unknown>;
    const candidates = [record.webhooks, record.data, record.items, record.results];
    for (const item of candidates) {
      if (Array.isArray(item)) return item;
      if (item && typeof item === "object") {
        const nested = item as Record<string, unknown>;
        if (Array.isArray(nested.webhooks)) return nested.webhooks;
        if (Array.isArray(nested.items)) return nested.items;
      }
    }
    return [];
  }

  private pickOrderObject(data: Record<string, unknown>): Record<string, unknown> {
    const candidates: unknown[] = [data.order, data.data, data.result, data];
    for (const item of candidates) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (row.order && typeof row.order === "object" && !Array.isArray(row.order)) {
        return row.order as Record<string, unknown>;
      }
      return row;
    }
    return {};
  }

  private verifyHmacBySecret(rawBody: Buffer, providedSignature: string, secret: string): boolean {
    if (!secret) return false;
    const provided = providedSignature.trim().replace(/^sha256=/i, "");
    const base64Digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    const hexDigest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    return this.safeEqual(provided, base64Digest) || this.safeEqual(provided, hexDigest);
  }

  private safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "utf8");
    const rightBuffer = Buffer.from(right, "utf8");
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  }

  private pickFirstString(...values: unknown[]): string {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return "";
  }

  private apiVersion(): string {
    return process.env.SHOPLINE_API_VERSION || "v20260301";
  }

  private autoSubscribeWebhook(): boolean {
    return String(process.env.SHOPLINE_AUTO_SUBSCRIBE_WEBHOOK || "false").toLowerCase() === "true";
  }

  private insecureTls(): boolean {
    return ["1", "true", "yes"].includes(String(process.env.SHOPLINE_INSECURE_TLS || "").toLowerCase());
  }

  private hasNoteText(existingNote: string, expectedNote: string): boolean {
    if (!existingNote || !expectedNote) return false;
    return existingNote.includes(expectedNote);
  }

  private formatAxiosError(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : String(error);
    }
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const method = error.config?.method?.toUpperCase() || "未知方法";
    const url = error.config?.url || "未知地址";
    const responseData =
      error.response?.data === undefined ? "" : ` response=${JSON.stringify(error.response.data)}`;
    return `${method} ${url} -> ${status || "无状态码"} ${statusText || ""} ${error.message}${responseData}`.trim();
  }
}
