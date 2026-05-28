import { BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AxiosInstance } from "axios";
import axios from "axios";
import * as crypto from "crypto";
import * as https from "https";
import { EnvConfig } from "../common/config/env.config";

@Injectable()
export class ShoplazzaService implements OnModuleInit {
  private readonly logger = new Logger(ShoplazzaService.name);
  constructor(private readonly env: EnvConfig) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.shoplazzaGlobal.autoSubscribeWebhook) return;
    for (const store of this.env.shoplazzaStores) {
      try {
        const result = await this.ensureOrderWebhook("orders/update", store.storeDomain);
        this.logger.log(
          `自动订阅 Shoplazza webhook 成功：store=${store.storeDomain} event=${result.topic} callback=${result.callback_url}`
        );
      } catch (error) {
        if (this.isTopicAlreadyExistsError(error)) {
          this.logger.log(
            `自动订阅 Shoplazza webhook 跳过：store=${store.storeDomain} topic=orders/update（已存在相同订阅）`
          );
          continue;
        }
        this.logger.error(
          `自动订阅 Shoplazza webhook 失败：store=${store.storeDomain} topic=orders/update ${this.formatAxiosError(error)}`
        );
      }
    }
  }

  private async ensureOrderUpdateWebhook(storeDomain: string) {
    return this.ensureOrderWebhook("orders/update", storeDomain);
  }

  private async ensureOrderWebhook(topic: string, storeDomain: string) {
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

    // Topic exists but callback is stale/invalid: remove and recreate.
    if (existing?.id) {
      await this.client(storeDomain).delete(`${listed.api_path}/${encodeURIComponent(existing.id)}`);
      this.logger.warn(
        `检测到 webhook 回调地址不匹配，已删除旧订阅：store=${storeDomain} topic=${topic} old=${existing.address} expected=${expectedAddress}`
      );
    }
    return this.subscribeOrderWebhook(topic, expectedAddress, storeDomain);
  }

  verifyWebhookSignature(rawBody: Buffer, providedHmac?: string, storeDomain?: string): boolean {
    return !!this.resolveVerifiedStoreDomain(rawBody, providedHmac, storeDomain);
  }

  resolveVerifiedStoreDomain(rawBody: Buffer, providedHmac?: string, storeDomain?: string): string | undefined {
    if (!providedHmac || !rawBody) return undefined;
    const preferredStore = this.env.findShoplazzaStore(storeDomain);
    if (this.verifyHmacBySecret(rawBody, providedHmac, preferredStore.webhookSecret)) {
      return preferredStore.storeDomain;
    }

    // Compatibility fallback: some webhook payloads/headers may not expose stable store domain.
    for (const store of this.env.shoplazzaStores) {
      if (store.storeDomain === preferredStore.storeDomain) continue;
      if (this.verifyHmacBySecret(rawBody, providedHmac, store.webhookSecret)) {
        this.logger.warn(
          `Webhook 验签已通过回退匹配：requestedStore=${storeDomain || "-"} matchedStore=${store.storeDomain}`
        );
        return store.storeDomain;
      }
    }
    return undefined;
  }

  async cancelOrder(orderId: string | number, reason = "fraud", storeDomain?: string): Promise<void> {
    await this.client(storeDomain).post(this.path(this.env.shoplazzaGlobal.cancelOrderPathTemplate, orderId), { reason });
  }

  async appendOrderNote(
    orderId: string | number,
    note: string,
    storeDomain?: string,
    existingNoteFromCaller?: string
  ): Promise<void> {
    const client = this.client(storeDomain);
    const existingNote =
      existingNoteFromCaller === undefined
        ? await this.readExistingOrderNote(orderId, storeDomain)
        : this.pickFirstString(existingNoteFromCaller);
    if (this.hasNoteText(existingNote, note)) {
      this.logger.log(`订单备注已存在：orderId=${String(orderId)}`);
      return;
    }

    const finalNote = existingNote ? `${existingNote}\n${note}` : note;
    const primaryPath = this.path(this.env.shoplazzaGlobal.updateOrderPathTemplate, orderId);
    const primaryPayload = { order: { id: orderId, note: finalNote } };
    const fallbackPaths = this.getOrderWritePaths(orderId).filter((path) => path !== primaryPath);
    const fallbackPayloads: Array<Record<string, unknown>> = [
      { order: { note: finalNote } },
      { note: finalNote },
      { remark: finalNote }
    ];
    const attempts: Array<{ path: string; payload: Record<string, unknown> }> = [
      { path: primaryPath, payload: primaryPayload },
      ...fallbackPaths.flatMap((path) => [
        { path, payload: primaryPayload },
        ...fallbackPayloads.map((payload) => ({ path, payload }))
      ])
    ];

    let lastError: unknown;
    for (const attempt of attempts) {
      const payloadType = this.describeOrderNotePayload(attempt.payload);
      try {
        await client.put(attempt.path, attempt.payload);
        if (!this.env.shoplazzaGlobal.confirmNoteWrite) {
          this.logger.log(
            `订单备注写入请求成功：orderId=${String(orderId)} writePath=${attempt.path} payloadType=${payloadType} confirmed=false`
          );
          return;
        }
        const readback = await this.getOrderReadback(orderId, storeDomain);
        const savedNote = this.pickOrderNoteWithCustomerNote(readback.order);
        if (this.hasNoteText(savedNote, note)) {
          this.logger.log(
            `订单备注写入成功：orderId=${String(orderId)} writePath=${attempt.path} payloadType=${payloadType} confirmed=true`
          );
          return;
        }
        lastError = new Error(
          `备注未落库，writePath=${attempt.path} readPath=${readback.usedPath} savedNote=${savedNote || "-"}`
        );
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) throw lastError;
    throw new Error("备注写入失败：未知错误");
  }

  private describeOrderNotePayload(payload: Record<string, unknown>): string {
    const order = payload.order;
    if (order && typeof order === "object" && !Array.isArray(order)) {
      const hasId = Object.prototype.hasOwnProperty.call(order, "id");
      return hasId ? "order.id+note" : "order.note";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "note")) return "note";
    if (Object.prototype.hasOwnProperty.call(payload, "remark")) return "remark";
    return "unknown";
  }

  private async readExistingOrderNote(orderId: string | number, storeDomain?: string): Promise<string> {
    const currentReadback = await this.getOrderReadback(orderId, storeDomain);
    return this.pickOrderNoteWithCustomerNote(currentReadback.order);
  }

  async getOrderReadback(orderId: string | number, storeDomain?: string): Promise<{
    order: Record<string, unknown>;
    usedPath: string;
    raw: Record<string, unknown>;
  }> {
    const client = this.client(storeDomain);
    const paths = this.getOrderReadPaths(orderId);
    let lastError: unknown;
    for (const path of paths) {
      try {
        const resp = await client.get(path);
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

  async subscribeOrderUpdateWebhook(callbackUrl?: string, storeDomain?: string) {
    return this.subscribeOrderWebhook("orders/update", callbackUrl, storeDomain);
  }

  async subscribeOrderWebhook(topic: string, callbackUrl?: string, storeDomain?: string) {
    const client = this.client(storeDomain);
    const address = this.resolveCallbackUrl(topic, callbackUrl);
    if (!address) {
      throw new BadRequestException(
        "缺少 callback_url。请配置 SHOPLAZZA_WEBHOOK_CALLBACK_URL，或在请求体中传入 callback_url。"
      );
    }

    const path = this.env.shoplazzaGlobal.subscribeWebhookPathTemplate.replace(
      "{version}",
      encodeURIComponent(this.env.shoplazzaGlobal.apiVersion)
    );
    const payload = this.buildSubscribePayload(path, address, topic);
    try {
      const resp = await client.post(path, payload);
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
        const fallbackResp = await client.post(fallbackPath, fallbackPayload);
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

  async listWebhooks(storeDomain?: string) {
    const client = this.client(storeDomain);
    const path = this.getWebhookCollectionPath();
    const resp = await client.get(path);
    const records = this.normalizeWebhookList(resp.data);
    return { api_path: path, count: records.length, records };
  }

  async cleanupWebhooks(keepTopics: string[] = ["orders/update"], storeDomain?: string) {
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

  private client(storeDomain?: string): AxiosInstance {
    const store = this.env.findShoplazzaStore(storeDomain);
    const httpsAgent = this.env.shoplazzaGlobal.insecureTls
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;

    return axios.create({
      baseURL: `https://${store.storeDomain}`,
      timeout: this.env.shoplazzaGlobal.timeoutMs,
      httpsAgent,
      headers: {
        "Content-Type": "application/json",
        // Keep both header variants for compatibility across Shoplazza API versions.
        "X-Shoplazza-Access-Token": store.adminToken,
        "access-token": store.adminToken
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
    const primary = this.path(this.env.shoplazzaGlobal.updateOrderPathTemplate, orderId);
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
    const primary = this.path(this.env.shoplazzaGlobal.updateOrderPathTemplate, orderId);
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

  private pickOrderNoteWithCustomerNote(order: Record<string, unknown>): string {
    const note = this.pickFirstString(order.note, order.order_note, order.memo, order.remark);
    const customerNote = this.pickFirstString(order.customer_note);
    const labeledCustomerNote = this.formatCustomerNote(customerNote);
    if (!note) return labeledCustomerNote;
    if (!customerNote || note.includes(customerNote)) return note;
    return `${note}\n${labeledCustomerNote}`;
  }

  private formatCustomerNote(customerNote: string): string {
    if (!customerNote) return "";
    if (customerNote.startsWith("【买家留言】")) return customerNote;
    return `【买家留言】${customerNote}`;
  }

  private getWebhookCollectionPath(): string {
    const path = this.env.shoplazzaGlobal.subscribeWebhookPathTemplate.replace(
      "{version}",
      encodeURIComponent(this.env.shoplazzaGlobal.apiVersion)
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

    const base = (this.env.shoplazzaGlobal.webhookCallbackUrl || "").trim();
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
    const method = error.config?.method?.toUpperCase() || "未知方法";
    const url = error.config?.url || "未知地址";
    const responseData =
      error.response?.data === undefined ? "" : ` response=${JSON.stringify(error.response.data)}`;

    return `${method} ${url} -> ${status || "无状态码"} ${statusText || ""} ${error.message}${responseData}`.trim();
  }

  private isTopicAlreadyExistsError(error: unknown): boolean {
    const text = this.extractErrorText(error).toLowerCase();
    if (!text.includes("topic already exists")) return false;

    // Prefer strict check when status is available.
    if (axios.isAxiosError(error)) {
      return error.response?.status === 422;
    }
    return text.includes("422") || text.includes("unprocessable entity");
  }

  private extractErrorText(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const responseData =
        error.response?.data === undefined ? "" : ` ${JSON.stringify(error.response.data)}`;
      return `${error.message}${responseData}`;
    }
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private verifyHmacBySecret(rawBody: Buffer, providedHmac: string, secret: string): boolean {
    const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
    const received = Buffer.from(providedHmac, "utf8");
    const expected = Buffer.from(digest, "utf8");
    if (received.length !== expected.length) return false;
    return crypto.timingSafeEqual(received, expected);
  }

  private hasNoteText(existingNote: string, expectedNote: string): boolean {
    if (!existingNote || !expectedNote) return false;
    return existingNote.includes(expectedNote);
  }
}
