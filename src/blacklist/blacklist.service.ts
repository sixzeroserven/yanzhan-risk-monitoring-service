import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import {
  getDeviceFingerprint,
  normalizeAddress,
  normalizeEmail,
  normalizePhone,
  safeString
} from "../common/utils/normalize.util";

export interface BlacklistHit {
  id: number;
  order_id: string;
  package_number: string;
  hit_type: string;
  hit_value: string;
}

export type ScoreExclusionReason = "non_regular_email" | "dispute_user";

export interface ScoreExclusionResult {
  excluded: boolean;
  reason: ScoreExclusionReason | null;
  remark: string;
  email: string;
  details?: Record<string, unknown>;
  hits?: Array<Record<string, unknown>>;
}

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  constructor(private readonly db: DatabaseService) {}

  async checkByInput(input: Record<string, unknown>) {
    const contact = {
      email: normalizeEmail(input.email),
      phoneNumber: normalizePhone(input.phone_number),
      detailAddress: normalizeAddress(input.detail_address),
      address2: normalizeAddress(input.address2),
      fingerprint: safeString(
        input.device_fingerprint || input.fingerprint || input.deviceFingerprint
      )
    };
    return this.checkByContact(contact);
  }

  async checkByOrder(order: Record<string, unknown>) {
    const shipping = this.asObject(order.shipping_address);
    const billing = this.asObject(order.billing_address);
    const customer = this.asObject(order.customer);
    const email = this.pickFirstString(
      order.email,
      order.contact_email,
      customer.email,
      customer.contact_email,
      shipping.email,
      billing.email,
      this.findFirstDeepString(order, new Set(["email", "contact_email", "buyer_account"]))
    );
    const phoneNumber = this.pickFirstString(
      order.phone_number,
      order.phone,
      order.mobile,
      shipping.phone,
      shipping.phone_number,
      shipping.mobile,
      shipping.tel,
      billing.phone,
      billing.phone_number,
      billing.mobile,
      billing.tel,
      customer.phone,
      customer.phone_number,
      customer.mobile,
      customer.tel,
      this.findFirstDeepString(
        order,
        new Set(["phone", "phone_number", "mobile", "tel", "telephone", "contact_phone"])
      )
    );
    const contact = {
      email: normalizeEmail(email),
      phoneNumber: normalizePhone(phoneNumber),
      detailAddress: normalizeAddress(shipping.address1 || billing.detail_address),
      address2: normalizeAddress(shipping.address2 || billing.address2),
      fingerprint: safeString(getDeviceFingerprint(order))
    };
    return this.checkByContact(contact);
  }

  async checkScoreExclusionByOrder(order: Record<string, unknown>): Promise<ScoreExclusionResult> {
    const email = this.extractEmailFromOrder(order);

    const nonRegularEmail = this.checkNonRegularEmail(email);
    if (nonRegularEmail.excluded) return nonRegularEmail;

    const disputeHits = await this.findDisputesByEmail(email);
    if (disputeHits.length > 0) {
      const first = disputeHits[0];
      const disputeId = safeString(first.dispute_id);
      const transactionId = safeString(first.seller_transaction_id);
      const orderId = safeString(first.order_id);
      const remarkParts = [
        `⚠️【不参与评分】争议用户：该邮箱关联 PayPal 争议订单`,
        disputeId ? `争议ID ${disputeId}` : "",
        transactionId ? `交易号 ${transactionId}` : "",
        orderId ? `关联订单 ${orderId}` : "",
        `不参与评分。`
      ].filter(Boolean);

      return {
        excluded: true,
        reason: "dispute_user",
        remark: remarkParts.join("，"),
        email,
        hits: disputeHits
      };
    }

    return { excluded: false, reason: null, remark: "", email };
  }

  async markOrderAsBlacklisted(order: Record<string, unknown>) {
    const orderId = safeString(order.id || order.order_id || order.order_number);
    if (!orderId) return;

    const shipping = this.asObject(order.shipping_address);
    const billing = this.asObject(order.billing_address);
    const customer = this.asObject(order.customer);

    await this.db.orderAddress.upsert({
      where: { orderId },
      create: {
        orderId,
        sourceId: safeString(order.source_id || order.source),
        phoneNumber: safeString(order.phone),
        country: safeString(shipping.country || billing.country),
        province: safeString(shipping.province || billing.province),
        city: safeString(shipping.city || billing.city),
        district: safeString(shipping.district || billing.district),
        contactPerson: safeString(
          shipping.name ||
            billing.name ||
            customer.name ||
            `${safeString(customer.first_name)} ${safeString(customer.last_name)}`.trim()
        ),
        mobile: normalizePhone(shipping.phone || billing.phone || order.phone),
        detailAddress: safeString(shipping.address1 || billing.address1 || shipping.address || billing.address),
        address2: safeString(shipping.address2 || billing.address2),
        email: normalizeEmail(order.email || customer.email)
      },
      update: {
        sourceId: safeString(order.source_id || order.source),
        phoneNumber: safeString(order.phone),
        country: safeString(shipping.country || billing.country),
        province: safeString(shipping.province || billing.province),
        city: safeString(shipping.city || billing.city),
        district: safeString(shipping.district || billing.district),
        contactPerson: safeString(
          shipping.name ||
            billing.name ||
            customer.name ||
            `${safeString(customer.first_name)} ${safeString(customer.last_name)}`.trim()
        ),
        mobile: normalizePhone(shipping.phone || billing.phone || order.phone),
        detailAddress: safeString(shipping.address1 || billing.address1 || shipping.address || billing.address),
        address2: safeString(shipping.address2 || billing.address2),
        email: normalizeEmail(order.email || customer.email)
      }
    });

    const packageNumber = safeString(order.package_number || order.packageNumber || order.name || orderId);
    await this.db.order.upsert({
      where: {
        orderId_packageNumber: {
          orderId,
          packageNumber
        }
      },
      create: {
        orderId,
        packageNumber,
        buyerName: safeString(customer.name || order.customer_name),
        contactName: safeString(shipping.name || billing.name || customer.name),
        buyerAccount: safeString(customer.email || order.email),
        buyerCountry: safeString(shipping.country || billing.country),
        blackState: true
      },
      update: {
        packageNumber,
        buyerName: safeString(customer.name || order.customer_name),
        contactName: safeString(shipping.name || billing.name || customer.name),
        buyerAccount: safeString(customer.email || order.email),
        buyerCountry: safeString(shipping.country || billing.country),
        blackState: true
      }
    });

    const deviceFingerprint = safeString(getDeviceFingerprint(order));
    if (deviceFingerprint) {
      await this.db.orderDeviceFingerprint.upsert({
        where: {
          orderId_deviceFingerprint: {
            orderId,
            deviceFingerprint
          }
        },
        create: {
          orderId,
          deviceFingerprint
        },
        update: {}
      });
    }
  }

  private async checkByContact(contact: {
    email: string;
    phoneNumber: string;
    detailAddress: string;
    address2: string;
    fingerprint: string;
  }) {
    const hits: BlacklistHit[] = [];
    hits.push(...(await this.findByEmail(contact.email)));
    hits.push(...(await this.findByPhoneNumber(contact.phoneNumber)));
    hits.push(...(await this.findByDetailAddress(contact.detailAddress)));
    hits.push(...(await this.findByAddress2(contact.address2)));
    hits.push(...(await this.findByFingerprint(contact.fingerprint)));
    return { blocked: hits.length > 0, contact, hits };
  }

  private extractEmailFromOrder(order: Record<string, unknown>): string {
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

  private checkNonRegularEmail(email: string): ScoreExclusionResult {
    if (!email) {
      return {
        excluded: true,
        reason: "non_regular_email",
        remark: "⚠️【不参与评分】非常规邮箱：订单未提供有效邮箱，不参与评分。",
        email,
        details: { rule: "empty_email" }
      };
    }

    const atCount = (email.match(/@/g) || []).length;
    const [localPart, domain] = email.split("@");
    if (
      atCount !== 1 ||
      !localPart ||
      !domain ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      domain.startsWith(".") ||
      domain.endsWith(".")
    ) {
      return {
        excluded: true,
        reason: "non_regular_email",
        remark: `⚠️【不参与评分】非常规邮箱：邮箱 ${email} 格式异常，不参与评分。`,
        email,
        details: { rule: "invalid_format" }
      };
    }

    const configuredDomains = this.configuredNonRegularEmailDomains();
    const disposableDomainTokens = [
      "10minutemail",
      "tempmail",
      "temp-mail",
      "mailinator",
      "guerrillamail",
      "yopmail",
      "trashmail",
      "sharklasers",
      "dispostable",
      "getnada",
      "maildrop"
    ];
    const matchedDomain =
      configuredDomains.find((item) => domain === item || domain.endsWith(`.${item}`)) ||
      disposableDomainTokens.find((item) => domain.includes(item));
    if (matchedDomain) {
      return {
        excluded: true,
        reason: "non_regular_email",
        remark: `⚠️【不参与评分】非常规邮箱：邮箱 ${email} 命中临时/异常邮箱域名 ${matchedDomain}，不参与评分。`,
        email,
        details: { rule: "domain", matchedDomain }
      };
    }

    const localLower = localPart.toLowerCase();
    const suspiciousLocalParts = ["test", "fake", "noreply", "no-reply", "donotreply", "do-not-reply"];
    const matchedLocalPart = suspiciousLocalParts.find(
      (item) => localLower === item || localLower.startsWith(`${item}+`)
    );
    if (matchedLocalPart) {
      return {
        excluded: true,
        reason: "non_regular_email",
        remark: `⚠️【不参与评分】非常规邮箱：邮箱 ${email} 命中异常邮箱名称 ${matchedLocalPart}，不参与评分。`,
        email,
        details: { rule: "local_part", matchedLocalPart }
      };
    }

    return { excluded: false, reason: null, remark: "", email };
  }

  private async findDisputesByEmail(email: string): Promise<Array<Record<string, unknown>>> {
    if (!email) return [];
    const startedAt = Date.now();
    try {
      const orderRows = (await this.db.$queryRawUnsafe(
        `
        SELECT DISTINCT
          o.order_id,
          o.transaction_id
        FROM order_address oa
        INNER JOIN orders o ON o.order_id = oa.order_id
        WHERE oa.email = ?
          AND o.transaction_id IS NOT NULL
          AND o.transaction_id <> ''
        LIMIT 50
      `,
        email
      )) as Array<Record<string, unknown>>;

      if (orderRows.length === 0) {
        this.logger.log(`争议用户查询完成：email=${email} transactions=0 hits=0 durationMs=${Date.now() - startedAt}`);
        return [];
      }

      const transactionIds = Array.from(
        new Set(orderRows.map((row) => safeString(row.transaction_id)).filter(Boolean))
      );
      if (transactionIds.length === 0) {
        this.logger.log(`争议用户查询完成：email=${email} transactions=0 hits=0 durationMs=${Date.now() - startedAt}`);
        return [];
      }

      const placeholders = transactionIds.map(() => "?").join(",");
      const disputeRows = (await this.db.$queryRawUnsafe(
        `
        SELECT
          pd.dispute_id,
          pd.dispute_state,
          pd.dispute_stage,
          pd.dispute_reason,
          pd.seller_transaction_id,
          pd.seller_transaction_id AS transaction_id
        FROM paypal_disputes pd
        WHERE pd.seller_transaction_id IN (${placeholders})
        ORDER BY COALESCE(pd.update_time, pd.create_time) DESC
        LIMIT 20
      `,
        ...transactionIds
      )) as Array<Record<string, unknown>>;

      const orderIdByTransaction = new Map(
        orderRows.map((row) => [safeString(row.transaction_id), safeString(row.order_id)])
      );
      const rows = disputeRows.map((row) => ({
        ...row,
        order_id: orderIdByTransaction.get(safeString(row.seller_transaction_id)) || ""
      }));
      this.logger.log(
        `争议用户查询完成：email=${email} transactions=${transactionIds.length} hits=${rows.length} durationMs=${Date.now() - startedAt}`
      );
      return rows;
    } catch (error) {
      this.logger.warn(`争议用户检查跳过：email=${email} durationMs=${Date.now() - startedAt} error=${this.formatError(error)}`);
      return [];
    }
  }

  private configuredNonRegularEmailDomains(): string[] {
    return safeString(process.env.NON_REGULAR_EMAIL_DOMAINS || process.env.IRREGULAR_EMAIL_DOMAINS)
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private async findByEmail(email: string): Promise<BlacklistHit[]> {
    if (!email) return [];
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number, 'email' AS hit_type, oa.email AS hit_value
      FROM order_address oa
      INNER JOIN orders o ON BINARY o.order_id = BINARY oa.order_id
      WHERE o.black_state = 1
        AND LOWER(TRIM(oa.email)) = ?
      LIMIT 20
    `,
      email
    );
    return rows as BlacklistHit[];
  }
  private async findByPhoneNumber(phoneNumber: string): Promise<BlacklistHit[]> {
    if (!phoneNumber) return [];
    const phoneLike = `%${phoneNumber}%`;
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number, 'phone_number' AS hit_type, oa.phone_number AS hit_value
       FROM order_address oa
       INNER JOIN orders o ON BINARY o.order_id = BINARY oa.order_id
       WHERE o.black_state = 1
         AND REPLACE(REPLACE(REPLACE(COALESCE(oa.phone_number, ''), ' ', ''), '-', ''), '(', '') LIKE ?
       LIMIT 20
    `,
      phoneLike
    );
    return rows as BlacklistHit[];
  }
  private async findByDetailAddress(detailAddress: string): Promise<BlacklistHit[]> {
    if (!detailAddress) return [];
    const addressLike = `%${detailAddress}%`;
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number, 'detail_address' AS hit_type, oa.detail_address AS hit_value
       FROM order_address oa
       INNER JOIN orders o ON BINARY o.order_id = BINARY oa.order_id
       WHERE o.black_state = 1
         AND LOWER(TRIM(COALESCE(oa.detail_address, ''))) LIKE ?
       LIMIT 20
    `,
      addressLike
    );
    return rows as BlacklistHit[];
  }
  private async findByAddress2(address2: string): Promise<BlacklistHit[]> {
    if (!address2) return [];
    const address2Like = `%${address2}%`;
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number, 'address2' AS hit_type, oa.address2 AS hit_value
      FROM order_address oa
      INNER JOIN orders o ON BINARY o.order_id = BINARY oa.order_id
      WHERE o.black_state = 1
        AND LOWER(TRIM(COALESCE(oa.address2, ''))) LIKE ?
      LIMIT 20
    `,
      address2Like
    );
    return rows as BlacklistHit[];
  }
  private async findByFingerprint(fingerprint: string): Promise<BlacklistHit[]> {
    if (!fingerprint) return [];
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number, 'device_fingerprint' AS hit_type, odf.device_fingerprint AS hit_value
      FROM order_device_fingerprint odf
      INNER JOIN orders o ON BINARY o.order_id = BINARY odf.order_id
      WHERE o.black_state = 1 AND BINARY odf.device_fingerprint = BINARY CAST(? AS CHAR(255)) LIMIT 20
    `,
      fingerprint
    );
    return rows as BlacklistHit[];
  }

  private pickFirstString(...values: unknown[]): string {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      const text = String(value).trim();
      if (text) return text;
    }
    return "";
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
}
