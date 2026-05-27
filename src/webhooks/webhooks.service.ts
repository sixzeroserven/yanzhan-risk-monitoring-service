import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import * as crypto from "crypto";
import { BlacklistService } from "../blacklist/blacklist.service";
import { normalizeEmail } from "../common/utils/normalize.util";
import { ShoplazzaService } from "../shoplazza/shoplazza.service";
import { ShoplineService } from "../shopline/shopline.service";
import { extractRiskIdentity } from "./webhook-order.util";

type WebhookPlatform = "shoplazza" | "shopline";

@Injectable()
export class WebhooksService {
  private static readonly RISK_FINGERPRINT_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly RISK_FINGERPRINT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  private readonly logger = new Logger(WebhooksService.name);
  private readonly lastRiskFingerprint = new Map<string, { fingerprint: string; expiresAt: number }>();
  private readonly inFlightRiskFingerprints = new Set<string>();
  private lastRiskFingerprintCleanupAt = 0;
  constructor(
    private readonly blacklistService: BlacklistService,
    private readonly shoplazzaService: ShoplazzaService,
    private readonly shoplineService: ShoplineService
  ) {}

  async processOrderUpdate(order: Record<string, unknown>, storeDomain?: string, platform: WebhookPlatform = "shoplazza") {
    const orderId = (
      order.order_id ||
      order.id ||
      order.source_id ||
      order.order_number ||
      order.number
    ) as string | number;
    if (!orderId) throw new BadRequestException("Webhook 载荷缺少订单号");
    const orderIdText = String(orderId);
    const receivedEmail = this.extractEmailForLog(order);
    this.logger.log(
      `Webhook 订单邮箱：orderId=${orderIdText} email=${receivedEmail || "-"} store=${storeDomain || "-"}`
    );
    const scopedOrderId = `${platform}::${String(storeDomain || "default").toLowerCase()}::${orderIdText}`;
    const fingerprint = this.buildRiskFingerprint(order);
    const now = Date.now();
    this.cleanupExpiredRiskFingerprints(now);
    const previousFingerprint = this.lastRiskFingerprint.get(scopedOrderId);
    if (previousFingerprint?.fingerprint === fingerprint && previousFingerprint.expiresAt > now) {
      this.logger.log(`订单信息未变化，跳过黑名单校验：orderId=${orderIdText}`);
      return { skipped: true, blocked: false, orderId };
    }
    const inFlightKey = `${scopedOrderId}::${fingerprint}`;
    if (this.inFlightRiskFingerprints.has(inFlightKey)) {
      this.logger.log(`订单相同风险信息正在处理中，跳过重复 webhook：orderId=${orderIdText}`);
      return { skipped: true, blocked: false, orderId, inFlight: true };
    }

    this.inFlightRiskFingerprints.add(inFlightKey);
    try {
      const result = await this.blacklistService.checkByOrder(order);
      const hitTypes = [...new Set(result.hits.map((item: { hit_type: string }) => item.hit_type))];
      if (result.blocked) {
        this.logger.log(
          `命中黑名单：orderId=${orderIdText} hitCount=${String(result.hits.length)} hitTypes=${hitTypes.join(",") || "none"} email=${result.contact.email || "-"} phone=${result.contact.phoneNumber || "-"} fingerprint=${result.contact.fingerprint || "-"}`
        );

        const note = `⚠️【黑名单拦截】命中规则：${hitTypes.join("、")}。该用户被识别为黑名单，请谨慎处理！`;
        const noteResult = await this.writeOrderNote(orderId, orderIdText, note, storeDomain, platform);
        this.logger.log(
          `订单处理结果：topic=orders/update orderId=${orderIdText} blacklisted=true scoreExcluded=true noteUpdated=${String(noteResult.noteUpdated)} noteConfirmed=${String(noteResult.noteConfirmed)}`
        );
        this.markRiskFingerprintProcessed(scopedOrderId, fingerprint);
        return {
          blocked: true,
          scoreExcluded: true,
          scoreExclusionReason: "blacklist",
          orderId,
          hitCount: result.hits.length,
          hitTypes,
          noteUpdated: noteResult.noteUpdated,
          noteConfirmed: noteResult.noteConfirmed
        };
      }

      const scoreExclusion = await this.blacklistService.checkScoreExclusionByOrder(order);
      if (!scoreExclusion.excluded) {
        const riskScore = await this.blacklistService.scoreByEmail(scoreExclusion.email);
        const scoreThreshold = this.riskScoreNoteThreshold();
        const shouldWriteRiskNote = riskScore.scored && riskScore.totalScore >= scoreThreshold;
        const noteResult = shouldWriteRiskNote
          ? await this.writeOrderNote(
              orderId,
              orderIdText,
              this.buildRiskScoreNote(riskScore, scoreThreshold),
              storeDomain,
              platform
            )
          : { noteUpdated: false, noteConfirmed: false };
        this.logger.log(
          `订单处理结果：topic=orders/update orderId=${orderIdText} blacklisted=false scoreExcluded=false riskScore=${String(riskScore.totalScore)} riskScoreNote=${String(shouldWriteRiskNote)} noteUpdated=${String(noteResult.noteUpdated)} noteConfirmed=${String(noteResult.noteConfirmed)}`
        );
        this.markRiskFingerprintProcessed(scopedOrderId, fingerprint);
        return {
          blocked: false,
          scoreExcluded: false,
          orderId,
          riskScore,
          riskScoreNote: shouldWriteRiskNote,
          noteUpdated: noteResult.noteUpdated,
          noteConfirmed: noteResult.noteConfirmed
        };
      }

      this.logger.log(
        `命中不参与评分规则：orderId=${orderIdText} reason=${scoreExclusion.reason || "-"} email=${scoreExclusion.email || "-"}`
      );
      const noteResult = await this.writeOrderNote(orderId, orderIdText, scoreExclusion.remark, storeDomain, platform);
      this.logger.log(
        `订单处理结果：topic=orders/update orderId=${orderIdText} blacklisted=false scoreExcluded=true reason=${scoreExclusion.reason || "-"} noteUpdated=${String(noteResult.noteUpdated)} noteConfirmed=${String(noteResult.noteConfirmed)}`
      );
      this.markRiskFingerprintProcessed(scopedOrderId, fingerprint);
      return {
        blocked: false,
        scoreExcluded: true,
        scoreExclusionReason: scoreExclusion.reason,
        remark: scoreExclusion.remark,
        orderId,
        noteUpdated: noteResult.noteUpdated,
        noteConfirmed: noteResult.noteConfirmed,
        details: scoreExclusion.details,
        hits: scoreExclusion.hits
      };
    } finally {
      this.inFlightRiskFingerprints.delete(inFlightKey);
    }
  }

  private markRiskFingerprintProcessed(scopedOrderId: string, fingerprint: string): void {
    this.lastRiskFingerprint.set(scopedOrderId, {
      fingerprint,
      expiresAt: Date.now() + WebhooksService.RISK_FINGERPRINT_TTL_MS
    });
  }

  private cleanupExpiredRiskFingerprints(now = Date.now()): void {
    if (now - this.lastRiskFingerprintCleanupAt < WebhooksService.RISK_FINGERPRINT_CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastRiskFingerprintCleanupAt = now;
    for (const [key, value] of this.lastRiskFingerprint.entries()) {
      if (value.expiresAt <= now) this.lastRiskFingerprint.delete(key);
    }
  }

  private async writeOrderNote(
    orderId: string | number,
    orderIdText: string,
    note: string,
    storeDomain?: string,
    platform: WebhookPlatform = "shoplazza"
  ): Promise<{ noteUpdated: boolean; noteConfirmed: boolean }> {
    let noteUpdated = true;
    let noteConfirmed = false;
    try {
      const noteService = this.noteService(platform);
      let existingNote = "";
      try {
        const currentReadback = await noteService.getOrderReadback(orderId, storeDomain);
        existingNote = this.pickFirstString(
          currentReadback.order?.note,
          currentReadback.order?.order_note,
          currentReadback.order?.customer_note,
          currentReadback.order?.memo,
          currentReadback.order?.remark
        );
      } catch (error) {
        if (platform !== "shopline") throw error;
        this.logger.warn(
          `Shopline 订单备注读取失败，将直接尝试写入：orderId=${orderIdText}，错误=${this.formatAxiosError(error)}`
        );
      }
      if (this.hasNoteText(existingNote, note)) {
        noteConfirmed = true;
        this.logger.log(`备注已存在，跳过重复写入：orderId=${orderIdText}`);
      } else {
        await noteService.appendOrderNote(orderId, note, storeDomain, existingNote);
        noteConfirmed = true;
      }
    } catch (error) {
      noteUpdated = false;
      this.logger.error(
        `订单备注写入失败：orderId=${orderIdText}，错误=${this.formatAxiosError(error)}`
      );
    }
    return { noteUpdated, noteConfirmed };
  }

  private noteService(platform: WebhookPlatform): {
    getOrderReadback: (
      orderId: string | number,
      storeDomain?: string
    ) => Promise<{ order: Record<string, unknown>; usedPath: string; raw: Record<string, unknown> }>;
    appendOrderNote: (
      orderId: string | number,
      note: string,
      storeDomain?: string,
      existingNoteFromCaller?: string
    ) => Promise<void>;
  } {
    return platform === "shopline" ? this.shoplineService : this.shoplazzaService;
  }

  private riskScoreNoteThreshold(): number {
    const parsed = Number(process.env.RISK_SCORE_NOTE_THRESHOLD || 10);
    return Number.isFinite(parsed) ? parsed : 10;
  }

  private buildRiskScoreNote(
    riskScore: { totalScore?: unknown; details?: unknown },
    threshold: number
  ): string {
    const details = this.asObject(riskScore.details);
    const unfinishedRatio = this.asObject(details.unfinishedRatio);
    const intervals = this.asObject(details.paidOrderIntervals);
    const days0To3 = this.asObject(intervals.days0To3);
    const days3To7 = this.asObject(intervals.days3To7);
    const daysOver7 = this.asObject(intervals.daysOver7);
    const relatedAccountCount = this.asObject(details.relatedAccountCount);
    const ipSwitchFrequency = this.asObject(details.ipSwitchFrequency);

    const totalScore = this.formatNumber(riskScore.totalScore);
    const totalOrders = this.formatNumber(details.totalOrders);
    const paidCount = this.formatNumber(details.paidCount);
    const orderedCount = this.formatNumber(details.orderedCount);
    const unfinishedRatioText = this.formatPercent(unfinishedRatio.value);
    const ipFrequency = this.formatNumber(ipSwitchFrequency.value);
    const distinctIpCount = this.formatNumber(ipSwitchFrequency.distinctIpCount);

    return [
      `⚠️【风险评分提醒】该用户风险评分 ${totalScore}，已达到备注阈值 ${this.formatNumber(threshold)}，请谨慎处理。`,
      `订单数：有效订单 ${totalOrders} 单，已付款订单 ${paidCount} 单，未完成/未付款订单 ${orderedCount} 单。`,
      `未完成订单占比：${unfinishedRatioText}。`,
      `时间间隔订单数：[0,3]天 ${this.formatNumber(days0To3.value)} 个，(3,7]天 ${this.formatNumber(days3To7.value)} 个，>7天 ${this.formatNumber(daysOver7.value)} 个。`,
      `关联账号数：${this.formatNumber(relatedAccountCount.value)}。`,
      `IP切换频率：${ipFrequency}（已付款订单数 ${paidCount} / 不同IP数 ${distinctIpCount}）。`
    ].join("\n");
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

  private extractEmailForLog(order: Record<string, unknown>): string {
    const shipping = this.asObject(order.shipping_address);
    const billing = this.asObject(order.billing_address);
    const customer = this.asObject(order.customer);
    return normalizeEmail(
      this.pickFirstString(
        order.email,
        order.contact_email,
        customer.email,
        customer.contact_email,
        shipping.email,
        billing.email,
        this.findFirstDeepString(order, new Set(["email", "contact_email", "buyer_account"]))
      )
    );
  }

  private asObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore parse errors and fall back to empty object.
      }
    }
    return {};
  }

  private toNumber(value: unknown): number {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private formatNumber(value: unknown): string {
    const numberValue = this.toNumber(value);
    if (Number.isInteger(numberValue)) return String(numberValue);
    return String(Math.round(numberValue * 10000) / 10000);
  }

  private formatPercent(value: unknown): string {
    return `${this.formatNumber(this.toNumber(value) * 100)}%`;
  }

  private findFirstDeepString(root: unknown, targetKeys: Set<string>): string {
    const visited = new Set<unknown>();
    const walk = (value: unknown, depth: number): string => {
      if (depth > 8 || value === null || value === undefined) return "";
      if (typeof value === "string") return "";
      if (typeof value !== "object") return "";
      if (visited.has(value)) return "";
      visited.add(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          const found = walk(item, depth + 1);
          if (found) return found;
        }
        return "";
      }

      const record = value as Record<string, unknown>;
      for (const [key, fieldValue] of Object.entries(record)) {
        if (targetKeys.has(key.toLowerCase())) {
          const text = this.pickFirstString(fieldValue);
          if (text) return text;
        }
      }
      for (const fieldValue of Object.values(record)) {
        const found = walk(fieldValue, depth + 1);
        if (found) return found;
      }
      return "";
    };

    return walk(root, 0);
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
