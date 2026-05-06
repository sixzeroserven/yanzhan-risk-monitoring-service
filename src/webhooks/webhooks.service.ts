import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import * as crypto from "crypto";
import { BlacklistService } from "../blacklist/blacklist.service";
import { ShoplazzaService } from "../shoplazza/shoplazza.service";
import { extractRiskIdentity } from "./webhook-order.util";

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly lastRiskFingerprint = new Map<string, string>();
  constructor(
    private readonly blacklistService: BlacklistService,
    private readonly shoplazzaService: ShoplazzaService
  ) {}

  async processOrderUpdate(order: Record<string, unknown>, storeDomain?: string) {
   // console.log("processOrderUpdate======---", order);
    const orderId = (
      order.order_id ||
      order.id ||
      order.source_id ||
      order.order_number ||
      order.number
    ) as string | number;
    if (!orderId) throw new BadRequestException("Webhook 载荷缺少订单号");
    const orderIdText = String(orderId);
    const scopedOrderId = `${String(storeDomain || "default").toLowerCase()}::${orderIdText}`;
    const fingerprint = this.buildRiskFingerprint(order);
    const previousFingerprint = this.lastRiskFingerprint.get(scopedOrderId);
    if (previousFingerprint === fingerprint) {
      this.logger.log(`订单信息未变化，跳过黑名单校验：orderId=${orderIdText}`);
      return { skipped: true, blocked: false, orderId };
    }
    this.lastRiskFingerprint.set(scopedOrderId, fingerprint);

    const result = await this.blacklistService.checkByOrder(order);
    const hitTypes = [...new Set(result.hits.map((item: { hit_type: string }) => item.hit_type))];
    if (!result.blocked) {
      this.logger.log(`订单处理结果：topic=orders/update orderId=${orderIdText} blacklisted=false noteUpdated=false`);
      return { blocked: false, orderId, noteUpdated: false };
    }
    this.logger.log(
      `命中黑名单：orderId=${orderIdText} hitCount=${String(result.hits.length)} hitTypes=${hitTypes.join(",") || "none"} email=${result.contact.email || "-"} phone=${result.contact.phoneNumber || "-"} fingerprint=${result.contact.fingerprint || "-"}`
    );

    const note = `⚠️【黑名单拦截】命中规则：${hitTypes.join("、")}。该用户被识别为黑名单，请谨慎处理！`;

    let noteUpdated = true;
    let noteConfirmed = false;
    try {
      const currentReadback = await this.shoplazzaService.getOrderReadback(orderId, storeDomain);
      const existingNote = this.pickFirstString(
        currentReadback.order?.note,
        currentReadback.order?.order_note,
        currentReadback.order?.customer_note,
        currentReadback.order?.memo
      );
      if (this.hasNoteText(existingNote, note)) {
        noteConfirmed = true;
        this.logger.log(`备注已存在，跳过重复写入：orderId=${orderIdText}`);
      } else {
      await this.shoplazzaService.appendOrderNote(orderId, note, storeDomain);
      try {
        const readback = await this.shoplazzaService.getOrderReadback(orderId, storeDomain);
        const latestOrder = readback.order;
        const savedNote = this.pickFirstString(
          latestOrder?.note,
          latestOrder?.order_note,
          latestOrder?.customer_note,
          latestOrder?.memo
        );
        noteConfirmed = this.hasNoteText(savedNote, note);
        const rawKeys = Object.keys(readback.raw || {}).join(",") || "-";
        const orderKeys = Object.keys(latestOrder || {}).join(",") || "-";
        this.logger.log(
          `备注回读校验：orderId=${orderIdText}`
        );
        if (!noteConfirmed) {
          const rawPreview = JSON.stringify(readback.raw || {}).slice(0, 800);
          this.logger.warn(`备注回读原始响应片段：orderId=${orderIdText} rawPreview=${rawPreview}`);
        }
      } catch (error) {
        this.logger.error(
          `备注回读校验失败：orderId=${orderIdText}，错误=${this.formatAxiosError(error)}`
        );
      }
      }
    } catch (error) {
      noteUpdated = false;
      this.logger.error(
        `订单备注写入失败：orderId=${orderIdText}，错误=${this.formatAxiosError(error)}`
      );
    }

    this.logger.log(
      `订单处理结果：topic=orders/update orderId=${orderIdText} blacklisted=true noteUpdated=${String(noteUpdated)} noteConfirmed=${String(noteConfirmed)}`
    );
    return { blocked: true, orderId, hitCount: result.hits.length, hitTypes, noteUpdated, noteConfirmed };
  }

  private buildRiskFingerprint(order: Record<string, unknown>): string {
    const risk = extractRiskIdentity(order);
    const normalized = JSON.stringify(risk);
    return crypto.createHash("sha256").update(normalized).digest("hex");
  }

  private pickFirstString(...values: unknown[]): string {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return "";
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

  private hasNoteText(existingNote: string, expectedNote: string): boolean {
    if (!existingNote || !expectedNote) return false;
    return existingNote.includes(expectedNote);
  }
}
