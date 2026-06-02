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
  package_number: string | null;
  hit_type: string;
  hit_value: string;
}

export type ScoreExclusionReason = "non_regular_email" | "dispute_user";
export type RiskScoreExcludeReason = ScoreExclusionReason | "blacklist" | "no_order";

export interface ScoreExclusionResult {
  excluded: boolean;
  reason: ScoreExclusionReason | null;
  remark: string;
  email: string;
  details?: Record<string, unknown>;
  hits?: Array<Record<string, unknown>>;
}

type RiskWeightRange = {
  min?: number;
  max?: number;
  weight: number;
  includeMin?: boolean;
  includeMax?: boolean;
};

type RiskScoreConfig = {
  paidOrderCount: {
    min: number;
    max: number;
    weights: RiskWeightRange[];
  };
  unfinishedRatio: {
    min: number;
    max: number;
    weights: RiskWeightRange[];
  };
  paidOrderIntervals: {
    min: number;
    max: number;
    buckets: {
      days0To3: { weight: number };
      days3To7: { weight: number };
      daysOver7: { weight: number };
    };
  };
  relatedAccountCount: {
    min: number;
    max: number;
    weight: number;
    enabledMinValue: number;
  };
  ipSwitchFrequency: {
    min: number;
    max: number;
    weight: number;
    enabledPaidCount: number;
  };
};

type RiskOrderRow = {
  id: number;
  order_id: string;
  package_number: string | null;
  order_state: string | null;
  order_created_time: Date | string | null;
  client_ip: string | null;
  province: string | null;
  city: string | null;
  detail_address: string | null;
};

const DEFAULT_RISK_SCORE_CONFIG: RiskScoreConfig = {
  paidOrderCount: {
    min: 1,
    max: 20,
    weights: [
      { min: 1, max: 5, weight: 0.05 },
      { min: 5, max: 10, weight: 0.1 },
      { min: 10, weight: 0.25 }
    ]
  },
  unfinishedRatio: {
    min: 0,
    max: 1,
    weights: [
      { max: 0.25, weight: 0.05, includeMax: true },
      { min: 0.25, weight: 0.1, includeMin: false }
    ]
  },
  paidOrderIntervals: {
    min: 0,
    max: 20,
    buckets: {
      days0To3: { weight: 0.25 },
      days3To7: { weight: 0.08 },
      daysOver7: { weight: 0.02 }
    }
  },
  relatedAccountCount: {
    min: 2,
    max: 4,
    weight: 0.08,
    enabledMinValue: 2
  },
  ipSwitchFrequency: {
    min: 1,
    max: 2,
    weight: 0.02,
    enabledPaidCount: 5
  }
};

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
      const buyerEmail = safeString(first.buyer_email);
      const transactionId = safeString(first.seller_transaction_id);
      const orderId = safeString(first.order_id);
      const remarkParts = [
        `⚠️【争议用户】该邮箱关联 PayPal 争议订单`,
        buyerEmail ? `争议邮箱 ${buyerEmail}` : "",
        disputeId ? `争议ID ${disputeId}` : "",
        transactionId ? `交易号 ${transactionId}` : "",
        orderId ? `关联订单 ${orderId}` : ""
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

  async scoreByInput(input: Record<string, unknown>) {
    return this.scoreByEmail(input.email);
  }

  async scoreByEmail(value: unknown) {
    const email = normalizeEmail(value);
    const startedAt = Date.now();

    const nonRegularEmail = this.checkNonRegularEmail(email);
    if (nonRegularEmail.excluded) {
      this.logger.log(
        `用户风险评分跳过：email=${email || "-"} reason=non_regular_email details=${JSON.stringify(nonRegularEmail.details || {})}`
      );
      return {
        email,
        scored: false,
        excluded: true,
        excludeReason: "non_regular_email" as RiskScoreExcludeReason,
        totalScore: 0,
        details: nonRegularEmail.details || {},
        remark: nonRegularEmail.remark
      };
    }

    const blacklistHits = await this.findByEmail(email);
    if (blacklistHits.length > 0) {
      this.logger.log(
        `用户风险评分跳过：email=${email} reason=blacklist hitCount=${blacklistHits.length}`
      );
      return {
        email,
        scored: false,
        excluded: true,
        excludeReason: "blacklist" as RiskScoreExcludeReason,
        totalScore: 0,
        hits: blacklistHits
      };
    }

    const disputeHits = await this.findDisputesByEmail(email);
    if (disputeHits.length > 0) {
      this.logger.log(
        `用户风险评分跳过：email=${email} reason=dispute_user hitCount=${disputeHits.length}`
      );
      return {
        email,
        scored: false,
        excluded: true,
        excludeReason: "dispute_user" as RiskScoreExcludeReason,
        totalScore: 0,
        hits: disputeHits
      };
    }

    const config = this.riskScoreConfig();
    const orders = await this.findRiskScoreOrdersByEmail(email);
    if (orders.length === 0) {
      this.logger.log(`用户风险评分跳过：email=${email} reason=no_order`);
      return {
        email,
        scored: false,
        excluded: true,
        excludeReason: "no_order" as RiskScoreExcludeReason,
        totalScore: 0,
        details: { validOrderCount: 0 }
      };
    }

    const relatedEmailCount = await this.countRelatedEmailsByAddress(email);
    const score = this.calculateRiskScore(config, orders, relatedEmailCount);

    this.logger.log(
      `用户风险评分完成：email=${email} totalScore=${score.totalScore} durationMs=${Date.now() - startedAt} details=${JSON.stringify(score.details)}`
    );
    return {
      email,
      scored: true,
      excluded: false,
      excludeReason: null,
      totalScore: score.totalScore,
      details: score.details
    };
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
        remark: "⚠️【邮箱异常】非常规邮箱：订单未提供有效邮箱。",
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
        remark: `⚠️【邮箱异常】非常规邮箱：邮箱 ${email} 格式异常。`,
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
        remark: `⚠️【邮箱异常】非常规邮箱：邮箱 ${email} 命中临时/异常邮箱域名 ${matchedDomain}。`,
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
        remark: `⚠️【邮箱异常】非常规邮箱：邮箱 ${email} 命中异常邮箱名称 ${matchedLocalPart}。`,
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
      const buyerEmailRows = await this.findDisputesByBuyerEmail(email);
      const orderRows = (await this.db.$queryRawUnsafe(
        `
        SELECT DISTINCT
          o.order_id,
          o.transaction_id
        FROM order_address oa
        INNER JOIN orders o ON o.order_id = oa.order_id
        WHERE LOWER(TRIM(oa.email)) = ?
          AND o.transaction_id IS NOT NULL
          AND o.transaction_id <> ''
        LIMIT 50
      `,
        email
      )) as Array<Record<string, unknown>>;

      const transactionIds = Array.from(
        new Set(orderRows.map((row) => safeString(row.transaction_id)).filter(Boolean))
      );
      let transactionRows: Array<Record<string, unknown>> = [];
      if (transactionIds.length > 0) {
        const placeholders = transactionIds.map(() => "?").join(",");
        const disputeRows = (await this.db.$queryRawUnsafe(
          `
          SELECT
            pd.dispute_id,
            pd.dispute_state,
            pd.dispute_stage,
            pd.dispute_reason,
            pd.buyer_email,
            pd.seller_transaction_id,
            pd.seller_transaction_id AS transaction_id,
            pd.create_time,
            pd.update_time,
            'seller_transaction_id' AS hit_source
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
        transactionRows = disputeRows.map((row) => ({
          ...row,
          order_id: orderIdByTransaction.get(safeString(row.seller_transaction_id)) || ""
        }));
      }

      const rows = this.dedupeDisputeRows([...buyerEmailRows, ...transactionRows]).slice(0, 20);
      this.logger.log(
        `争议用户查询完成：email=${email} buyerEmailHits=${buyerEmailRows.length} transactions=${transactionIds.length} hits=${rows.length} durationMs=${Date.now() - startedAt}`
      );
      return rows;
    } catch (error) {
      this.logger.warn(`争议用户检查跳过：email=${email} durationMs=${Date.now() - startedAt} error=${this.formatError(error)}`);
      return [];
    }
  }

  private async findDisputesByBuyerEmail(email: string): Promise<Array<Record<string, unknown>>> {
    if (!email) return [];
    try {
      const rows = (await this.db.$queryRawUnsafe(
        `
        SELECT
          pd.dispute_id,
          pd.dispute_state,
          pd.dispute_stage,
          pd.dispute_reason,
          pd.buyer_email,
          pd.seller_transaction_id,
          pd.seller_transaction_id AS transaction_id,
          pd.create_time,
          pd.update_time,
          'buyer_email' AS hit_source,
          '' AS order_id
        FROM paypal_disputes pd
        WHERE LOWER(TRIM(pd.buyer_email)) = ?
        ORDER BY COALESCE(pd.update_time, pd.create_time) DESC
        LIMIT 20
      `,
        email
      )) as Array<Record<string, unknown>>;
      return rows;
    } catch (error) {
      this.logger.warn(`争议邮箱直接查询跳过：email=${email} error=${this.formatError(error)}`);
      return [];
    }
  }

  private dedupeDisputeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const seen = new Set<string>();
    const deduped: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const key = safeString(row.dispute_id) || `${safeString(row.seller_transaction_id)}:${safeString(row.buyer_email)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }
    return deduped;
  }

  private async findRiskScoreOrdersByEmail(email: string): Promise<RiskOrderRow[]> {
    if (!email) return [];
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT
        o.id,
        o.order_id,
        o.package_number,
        o.order_state,
        o.order_created_time,
        o.client_ip,
        oa.province,
        oa.city,
        oa.detail_address
      FROM order_address oa
      INNER JOIN orders o ON BINARY o.order_id = BINARY oa.order_id
      WHERE LOWER(TRIM(oa.email)) = ?
        AND o.order_created_time IS NOT NULL
      ORDER BY o.order_id ASC, o.order_created_time DESC, o.id DESC
    `,
      email
    );
    return this.dedupeRiskOrderRowsByOrderId(rows as RiskOrderRow[]);
  }

  private dedupeRiskOrderRowsByOrderId(rows: RiskOrderRow[]): RiskOrderRow[] {
    const byOrderId = new Map<string, RiskOrderRow>();
    for (const row of rows) {
      const orderId = safeString(row.order_id);
      if (!orderId || byOrderId.has(orderId)) continue;
      byOrderId.set(orderId, row);
    }
    return Array.from(byOrderId.values()).sort((left, right) => {
      const leftTime = this.toTimestamp(left.order_created_time) || 0;
      const rightTime = this.toTimestamp(right.order_created_time) || 0;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return this.toNumber(left.id) - this.toNumber(right.id);
    });
  }

  private async countRelatedEmailsByAddress(email: string): Promise<number> {
    if (!email) return 0;
    const rows = (await this.db.$queryRawUnsafe(
      `
      SELECT COUNT(DISTINCT LOWER(TRIM(oa2.email))) AS related_email_count
      FROM order_address oa2
      INNER JOIN orders o2 ON BINARY o2.order_id = BINARY oa2.order_id
      INNER JOIN (
        SELECT DISTINCT
          LOWER(TRIM(COALESCE(oa.province, ''))) AS province_key,
          LOWER(TRIM(COALESCE(oa.city, ''))) AS city_key,
          LOWER(TRIM(COALESCE(oa.detail_address, ''))) AS detail_address_key
        FROM order_address oa
        INNER JOIN orders o ON BINARY o.order_id = BINARY oa.order_id
        WHERE LOWER(TRIM(oa.email)) = ?
          AND o.order_created_time IS NOT NULL
          AND TRIM(COALESCE(oa.detail_address, '')) <> ''
      ) addr
        ON LOWER(TRIM(COALESCE(oa2.province, ''))) = addr.province_key
       AND LOWER(TRIM(COALESCE(oa2.city, ''))) = addr.city_key
       AND LOWER(TRIM(COALESCE(oa2.detail_address, ''))) = addr.detail_address_key
      WHERE oa2.email IS NOT NULL
        AND TRIM(oa2.email) <> ''
        AND o2.order_created_time IS NOT NULL
    `,
      email
    )) as Array<Record<string, unknown>>;
    return this.toNumber(rows[0]?.related_email_count);
  }

  private calculateRiskScore(
    config: RiskScoreConfig,
    orders: RiskOrderRow[],
    relatedEmailCount: number
  ): { totalScore: number; details: Record<string, unknown> } {
    const totalOrders = orders.length;
    const paidOrders = orders.filter((row) => this.isPaidOrderState(row.order_state));
    const paidCount = paidOrders.length;
    const orderedCount = orders.filter((row) => this.orderStateText(row.order_state) === "ordered").length;

    const paidWeight = this.matchRiskWeight(paidCount, config.paidOrderCount.weights);
    const paidNormalized = this.normalizePositive(
      paidCount,
      config.paidOrderCount.min,
      config.paidOrderCount.max
    );
    const paidScore = paidNormalized * paidWeight * 100;

    const unfinishedRatio = totalOrders > 0 ? orderedCount / totalOrders : 0;
    const unfinishedWeight = totalOrders > 0 ? this.matchRiskWeight(unfinishedRatio, config.unfinishedRatio.weights) : 0;
    const unfinishedNormalized = totalOrders > 0
      ? this.normalizePositive(unfinishedRatio, config.unfinishedRatio.min, config.unfinishedRatio.max)
      : 0;
    const unfinishedScore = unfinishedNormalized * unfinishedWeight * 100;

    const intervalCounts = this.countPaidOrderIntervals(paidOrders);
    const intervalEnabled = paidCount >= 2;
    const intervalMin = config.paidOrderIntervals.min;
    const intervalMax = config.paidOrderIntervals.max;
    const days0To3Score = intervalEnabled
      ? this.normalizePositive(intervalCounts.days0To3, intervalMin, intervalMax) *
        config.paidOrderIntervals.buckets.days0To3.weight *
        100
      : 0;
    const days3To7Score = intervalEnabled
      ? this.normalizePositive(intervalCounts.days3To7, intervalMin, intervalMax) *
        config.paidOrderIntervals.buckets.days3To7.weight *
        100
      : 0;
    const daysOver7Score = intervalEnabled
      ? this.normalizePositive(intervalCounts.daysOver7, intervalMin, intervalMax) *
        config.paidOrderIntervals.buckets.daysOver7.weight *
        100
      : 0;
    const intervalScore = days0To3Score + days3To7Score + daysOver7Score;

    const relatedEnabled = relatedEmailCount >= config.relatedAccountCount.enabledMinValue;
    const relatedNormalized = relatedEnabled
      ? this.normalizePositive(relatedEmailCount, config.relatedAccountCount.min, config.relatedAccountCount.max)
      : 0;
    const relatedScore = relatedNormalized * config.relatedAccountCount.weight * 100;

    const distinctIpCount = new Set(
      paidOrders.map((row) => safeString(row.client_ip)).filter(Boolean)
    ).size;
    const ipFrequency = distinctIpCount > 0 ? paidCount / distinctIpCount : 0;
    const ipEnabled =
      paidCount >= config.ipSwitchFrequency.enabledPaidCount &&
      distinctIpCount > 0 &&
      ipFrequency >= config.ipSwitchFrequency.min &&
      ipFrequency <= config.ipSwitchFrequency.max;
    const ipNormalized = ipEnabled
      ? this.normalizeReverse(ipFrequency, config.ipSwitchFrequency.min, config.ipSwitchFrequency.max)
      : 0;
    const ipScore = ipNormalized * config.ipSwitchFrequency.weight * 100;

    const totalScore = paidScore + unfinishedScore + intervalScore + relatedScore + ipScore;
    const details = {
      totalOrders,
      paidCount,
      orderedCount,
      paidOrderCount: {
        value: paidCount,
        min: config.paidOrderCount.min,
        max: config.paidOrderCount.max,
        weight: paidWeight,
        normalized: this.roundScore(paidNormalized),
        score: this.roundScore(paidScore)
      },
      unfinishedRatio: {
        value: this.roundScore(unfinishedRatio),
        orderedCount,
        totalOrders,
        min: config.unfinishedRatio.min,
        max: config.unfinishedRatio.max,
        weight: unfinishedWeight,
        normalized: this.roundScore(unfinishedNormalized),
        score: this.roundScore(unfinishedScore)
      },
      paidOrderIntervals: {
        enabled: intervalEnabled,
        min: intervalMin,
        max: intervalMax,
        days0To3: {
          value: intervalCounts.days0To3,
          weight: config.paidOrderIntervals.buckets.days0To3.weight,
          normalized: this.roundScore(intervalEnabled ? this.normalizePositive(intervalCounts.days0To3, intervalMin, intervalMax) : 0),
          score: this.roundScore(days0To3Score)
        },
        days3To7: {
          value: intervalCounts.days3To7,
          weight: config.paidOrderIntervals.buckets.days3To7.weight,
          normalized: this.roundScore(intervalEnabled ? this.normalizePositive(intervalCounts.days3To7, intervalMin, intervalMax) : 0),
          score: this.roundScore(days3To7Score)
        },
        daysOver7: {
          value: intervalCounts.daysOver7,
          weight: config.paidOrderIntervals.buckets.daysOver7.weight,
          normalized: this.roundScore(intervalEnabled ? this.normalizePositive(intervalCounts.daysOver7, intervalMin, intervalMax) : 0),
          score: this.roundScore(daysOver7Score)
        },
        score: this.roundScore(intervalScore)
      },
      relatedAccountCount: {
        enabled: relatedEnabled,
        value: relatedEmailCount,
        min: config.relatedAccountCount.min,
        max: config.relatedAccountCount.max,
        weight: config.relatedAccountCount.weight,
        normalized: this.roundScore(relatedNormalized),
        score: this.roundScore(relatedScore)
      },
      ipSwitchFrequency: {
        enabled: ipEnabled,
        value: this.roundScore(ipFrequency),
        paidCount,
        distinctIpCount,
        min: config.ipSwitchFrequency.min,
        max: config.ipSwitchFrequency.max,
        weight: config.ipSwitchFrequency.weight,
        normalized: this.roundScore(ipNormalized),
        score: this.roundScore(ipScore)
      }
    };

    return { totalScore: this.roundScore(totalScore), details };
  }

  private countPaidOrderIntervals(rows: RiskOrderRow[]): {
    days0To3: number;
    days3To7: number;
    daysOver7: number;
  } {
    const timestamps = rows
      .map((row) => this.toTimestamp(row.order_created_time))
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right);
    const counts = { days0To3: 0, days3To7: 0, daysOver7: 0 };
    for (let index = 1; index < timestamps.length; index += 1) {
      const days = (timestamps[index] - timestamps[index - 1]) / 86400000;
      if (days >= 0 && days <= 3) counts.days0To3 += 1;
      else if (days > 3 && days <= 7) counts.days3To7 += 1;
      else if (days > 7) counts.daysOver7 += 1;
    }
    return counts;
  }

  private riskScoreConfig(): RiskScoreConfig {
    const raw = safeString(process.env.RISK_SCORE_CONFIG_JSON);
    if (!raw) return DEFAULT_RISK_SCORE_CONFIG;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.mergeRiskScoreConfig(DEFAULT_RISK_SCORE_CONFIG, parsed) as RiskScoreConfig;
    } catch (error) {
      this.logger.warn(`风险评分配置解析失败，使用默认配置：error=${this.formatError(error)}`);
      return DEFAULT_RISK_SCORE_CONFIG;
    }
  }

  private mergeRiskScoreConfig(base: unknown, override: unknown): unknown {
    if (Array.isArray(base)) return Array.isArray(override) ? override : base;
    if (!base || typeof base !== "object") return override === undefined ? base : override;
    if (!override || typeof override !== "object" || Array.isArray(override)) return base;

    const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      merged[key] = this.mergeRiskScoreConfig(merged[key], value);
    }
    return merged;
  }

  private matchRiskWeight(value: number, ranges: RiskWeightRange[]): number {
    for (const range of ranges) {
      const minOk =
        range.min === undefined ||
        (range.includeMin === false ? value > range.min : value >= range.min);
      const maxOk =
        range.max === undefined ||
        (range.includeMax === true ? value <= range.max : value < range.max);
      if (minOk && maxOk) return Number(range.weight || 0);
    }
    return 0;
  }

  private normalizePositive(value: number, min: number, max: number): number {
    if (max === min) return 0;
    return (value - min) / (max - min);
  }

  private normalizeReverse(value: number, min: number, max: number): number {
    if (max === min) return 0;
    return (max - value) / (max - min);
  }

  private isPaidOrderState(value: unknown): boolean {
    return this.orderStateText(value) !== "ordered";
  }

  private orderStateText(value: unknown): string {
    return safeString(value).trim().toLowerCase();
  }

  private toTimestamp(value: unknown): number | null {
    if (!value) return null;
    const timestamp = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  private toNumber(value: unknown): number {
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private roundScore(value: number): number {
    return Math.round(value * 1000000) / 1000000;
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
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number, 'detail_address' AS hit_type, oa.detail_address AS hit_value
       FROM order_address oa
       INNER JOIN orders o ON BINARY o.order_id = BINARY oa.order_id
       WHERE o.black_state = 1
         AND LOWER(TRIM(COALESCE(oa.detail_address, ''))) = ?
       LIMIT 20
    `,
      detailAddress
    );
    return rows as BlacklistHit[];
  }
  private async findByAddress2(address2: string): Promise<BlacklistHit[]> {
    if (!address2) return [];
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number, 'address2' AS hit_type, oa.address2 AS hit_value
      FROM order_address oa
      INNER JOIN orders o ON BINARY o.order_id = BINARY oa.order_id
      WHERE o.black_state = 1
        AND LOWER(TRIM(COALESCE(oa.address2, ''))) = ?
      LIMIT 20
    `,
      address2
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
