import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import axios from "axios";
import * as crypto from "crypto";
import * as https from "https";
import { EnvConfig } from "../common/config/env.config";

@Injectable()
export class ShoplazzaService implements OnModuleInit {
  private readonly logger = new Logger(ShoplazzaService.name);
  constructor(private readonly env: EnvConfig) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.shoplazza.autoSubscribeWebhook) return;
    try {
      const result = await this.subscribeOrderUpdateWebhook();
      this.logger.log(
        `自动订阅 Shoplazza webhook 成功：event=${result.topic} callback=${result.callback_url}`
      );
    } catch (error) {
      this.logger.error(
        `自动订阅 Shoplazza webhook 失败：${this.formatAxiosError(error)}`
      );
    }
  }

  verifyWebhookSignature(rawBody: Buffer, providedHmac?: string): boolean {
    if (!providedHmac || !rawBody) return false;
    const digest = crypto
      .createHmac("sha256", this.env.shoplazza.webhookSecret)
      .update(rawBody)
      .digest("base64");
    const received = Buffer.from(providedHmac, "utf8");
    const expected = Buffer.from(digest, "utf8");
    if (received.length !== expected.length) return false;
    return crypto.timingSafeEqual(received, expected);
  }

  async cancelOrder(orderId: string | number, reason = "fraud"): Promise<void> {
    await this.client.post(this.path(this.env.shoplazza.cancelOrderPathTemplate, orderId), { reason });
  }

  async appendOrderNote(orderId: string | number, note: string): Promise<void> {
    const paths = this.getOrderWritePaths(orderId);
    const payloads: Array<Record<string, unknown>> = [
      { order: { id: orderId, note } },
      { order: { note } },
      { note },
      { remark: note }
    ];

    let lastError: unknown;
    for (const path of paths) {
      for (const payload of payloads) {
        try {
          await this.client.put(path, payload);
          const readback = await this.getOrderReadback(orderId);
          const savedNote = this.pickFirstString(
            readback.order.note,
            readback.order.order_note,
            readback.order.customer_note,
            readback.order.memo
          );
          if (savedNote.includes("Blacklist matched.")) {
            this.logger.log(
              `订单备注写入成功：orderId=${String(orderId)} writePath=${path} readPath=${readback.usedPath}`
            );
            return;
          }
          lastError = new Error(
            `备注未落库，writePath=${path} readPath=${readback.usedPath} savedNote=${savedNote || "-"}`
          );
        } catch (error) {
          lastError = error;
        }
      }
    }

    if (lastError) throw lastError;
    throw new Error("备注写入失败：未知错误");
  }

  async getOrderReadback(orderId: string | number): Promise<{
    order: Record<string, unknown>;
    usedPath: string;
    raw: Record<string, unknown>;
  }> {
    const paths = this.getOrderReadPaths(orderId);
    let lastError: unknown;
    for (const path of paths) {
      try {
        const resp = await this.client.get(path);
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

  async subscribeOrderUpdateWebhook(callbackUrl?: string) {
    return this.subscribeOrderWebhook("orders/update", callbackUrl);
  }

  async subscribeOrderWebhook(topic: string, callbackUrl?: string) {
    const address = this.resolveCallbackUrl(topic, callbackUrl);
    if (!address) {
      throw new BadRequestException(
        "缺少 callback_url。请配置 SHOPLAZZA_WEBHOOK_CALLBACK_URL，或在请求体中传入 callback_url。"
      );
    }

    const path = this.env.shoplazza.subscribeWebhookPathTemplate.replace(
      "{version}",
      encodeURIComponent(this.env.shoplazza.apiVersion)
    );
    const payload = this.buildSubscribePayload(path, address, topic);
    try {
      const resp = await this.client.post(path, payload);
      return {
        success: true,
        topic,
        callback_url: address,
        api_path: path,
        data: resp.data
      };
    } catch (error) {
      const fallbackPath = this.getFallbackWebhookPath(path);
      if (fallbackPath && this.isNotFoundError(error)) {
        this.logger.warn(
          `Webhook 订阅路径不存在：${path}，将使用回退路径重试：${fallbackPath}`
        );
        const fallbackPayload = this.buildSubscribePayload(fallbackPath, address, topic);
        const fallbackResp = await this.client.post(fallbackPath, fallbackPayload);
        return {
          success: true,
          topic,
          callback_url: address,
          api_path: fallbackPath,
          data: fallbackResp.data
        };
      }

      throw new BadRequestException(
        `订阅 webhook 请求被拒绝。${this.formatAxiosError(error)}`
      );
    }
  }

  async listWebhooks() {
    const path = this.getWebhookCollectionPath();
    const resp = await this.client.get(path);
    const records = this.normalizeWebhookList(resp.data);
    return { api_path: path, count: records.length, records };
  }

  async cleanupWebhooks(keepTopics: string[] = ["orders/update"]) {
    const keep = new Set(keepTopics.map((item) => item.trim()).filter(Boolean));
    const listed = await this.listWebhooks();
    const removed: Array<{ id: string; topic: string }> = [];
    const kept: Array<{ id: string; topic: string }> = [];

    for (const item of listed.records) {
      if (!item.id || keep.has(item.topic)) {
        kept.push({ id: item.id || "-", topic: item.topic || "-" });
        continue;
      }
      await this.client.delete(`${listed.api_path}/${encodeURIComponent(item.id)}`);
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

  private get client() {
    const httpsAgent = this.env.shoplazza.insecureTls
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;

    return axios.create({
      baseURL: `https://${this.env.shoplazza.storeDomain}`,
      timeout: this.env.shoplazza.timeoutMs,
      httpsAgent,
      headers: {
        "Content-Type": "application/json",
        // Keep both header variants for compatibility across Shoplazza API versions.
        "X-Shoplazza-Access-Token": this.env.shoplazza.adminToken,
        "access-token": this.env.shoplazza.adminToken
      }
    });
  }

  private path(template: string, orderId: string | number): string {
    return template.replace("{orderId}", encodeURIComponent(String(orderId)));
  }

  private getFallbackWebhookPath(path: string): string | undefined {
    return path.endsWith("/webhooks/subscribe")
      ? path.replace(/\/webhooks\/subscribe$/, "/webhooks")
      : undefined;
  }

  private getOrderReadPaths(orderId: string | number): string[] {
    const primary = this.path(this.env.shoplazza.updateOrderPathTemplate, orderId);
    const variants = new Set<string>([primary]);

    if (!primary.endsWith(".json")) variants.add(`${primary}.json`);
    if (primary.endsWith(".json")) variants.add(primary.slice(0, -".json".length));

    if (!primary.startsWith("/admin/openapi/")) {
      variants.add(primary.replace(/^\/openapi\//, "/admin/openapi/"));
      if (!primary.endsWith(".json")) {
        variants.add(primary.replace(/^\/openapi\//, "/admin/openapi/") + ".json");
      }
    }

    return Array.from(variants);
  }

  private getOrderWritePaths(orderId: string | number): string[] {
    const primary = this.path(this.env.shoplazza.updateOrderPathTemplate, orderId);
    const variants = new Set<string>([primary]);

    if (!primary.endsWith(".json")) variants.add(`${primary}.json`);
    if (primary.endsWith(".json")) variants.add(primary.slice(0, -".json".length));

    if (primary.startsWith("/openapi/")) {
      const adminBase = primary.replace(/^\/openapi\//, "/admin/openapi/");
      variants.add(adminBase);
      if (!adminBase.endsWith(".json")) variants.add(`${adminBase}.json`);
    }
    if (primary.startsWith("/admin/openapi/")) {
      const openapiBase = primary.replace(/^\/admin\/openapi\//, "/openapi/");
      variants.add(openapiBase);
      if (!openapiBase.endsWith(".json")) variants.add(`${openapiBase}.json`);
    }

    return Array.from(variants);
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

  private pickFirstString(...values: unknown[]): string {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return "";
  }

  private getWebhookCollectionPath(): string {
    const path = this.env.shoplazza.subscribeWebhookPathTemplate.replace(
      "{version}",
      encodeURIComponent(this.env.shoplazza.apiVersion)
    );
    if (path.endsWith("/webhooks/subscribe")) {
      return path.replace(/\/webhooks\/subscribe$/, "/webhooks");
    }
    return path;
  }

  private normalizeWebhookList(data: unknown): Array<{ id: string; topic: string; address: string }> {
    const rows = this.pickWebhookArray(data);
    return rows
      .map((item) => {
        const row = item as Record<string, unknown>;
        return {
          id: String(row.id || row.webhook_id || row.uuid || ""),
          topic: String(row.topic || row.event || ""),
          address: String(row.address || row.callback_url || row.url || "")
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

  private isNotFoundError(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 404;
  }

  private buildSubscribePayload(path: string, address: string, topic: string): Record<string, string> {
    if (path.endsWith("/webhooks")) {
      return {
        topic,
        address
      };
    }

    return {
      event: topic,
      address
    };
  }

  private resolveCallbackUrl(topic: string, callbackUrl?: string): string {
    const explicit = (callbackUrl || "").trim();
    if (explicit) return explicit;

    const base = (this.env.shoplazza.webhookCallbackUrl || "").trim();
    if (!base) return "";

    const suffix = topic.split("/")[1] || "update";
    if (base.endsWith("/create") || base.endsWith("/paid") || base.endsWith("/update")) {
      const parts = base.split("/");
      parts[parts.length - 1] = suffix;
      return parts.join("/");
    }
    return base;
  }

  private formatAxiosError(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error.message : String(error);
    }

    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const method = error.config?.method?.toUpperCase() || "UNKNOWN";
    const url = error.config?.url || "UNKNOWN_URL";
    const responseData =
      error.response?.data === undefined ? "" : ` response=${JSON.stringify(error.response.data)}`;

    return `${method} ${url} -> ${status || "NO_STATUS"} ${statusText || ""} ${error.message}${responseData}`.trim();
  }
}
