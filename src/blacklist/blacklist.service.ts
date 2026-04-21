import { Injectable } from "@nestjs/common";
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

@Injectable()
export class BlacklistService {
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
    const shipping = (order.shipping_address as Record<string, unknown>) || {};
    const billing = (order.billing_address as Record<string, unknown>) || {};
    const contact = {
      email: normalizeEmail(order.email),
      phoneNumber: normalizePhone(order.phone_number || shipping.phone || billing.phone || order.phone),
      detailAddress: normalizeAddress(shipping.detail_address || billing.detail_address),
      address2: normalizeAddress(shipping.address2 || billing.address2),
      fingerprint: safeString(getDeviceFingerprint(order))
    };
    return this.checkByContact(contact);
  }

  async markOrderAsBlacklisted(order: Record<string, unknown>) {
    const orderId = safeString(order.id || order.order_id || order.order_number);
    if (!orderId) return;

    const shipping = (order.shipping_address as Record<string, unknown>) || {};
    const billing = (order.billing_address as Record<string, unknown>) || {};
    const customer = (order.customer as Record<string, unknown>) || {};

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
    const blacklistedOrders = await this.getBlacklistedOrders();
    if (!blacklistedOrders.length) return { blocked: false, contact, hits: [] };

    const [emailHits, phoneNumberHits, detailAddressHits, address2Hits, fingerprintHits] = await Promise.all([
      this.findByEmail(contact.email),
      this.findByPhoneNumber(contact.phoneNumber),
      this.findByDetailAddress(contact.detailAddress),
      this.findByAddress2(contact.address2),
      this.findByFingerprint(contact.fingerprint)
    ]);
    const hits = [...emailHits, ...phoneNumberHits, ...detailAddressHits, ...address2Hits, ...fingerprintHits];
    return { blocked: hits.length > 0, contact, hits };
  }

  private async getBlacklistedOrders(): Promise<Array<{ id: number; order_id: string; package_number: string }>> {
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number
      FROM orders o
      WHERE o.black_state = 1
    `
    );
    return rows as Array<{ id: number; order_id: string; package_number: string }>;
  }

  private async findByEmail(email: string): Promise<BlacklistHit[]> {
    if (!email) return [];
    const rows = await this.db.$queryRawUnsafe(
      `
      SELECT o.id, o.order_id, o.package_number, 'email' AS hit_type, oa.email AS hit_value
      FROM order_address oa
      INNER JOIN orders o ON o.order_id = oa.order_id
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
       INNER JOIN orders o ON o.order_id = oa.order_id
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
       INNER JOIN orders o ON o.order_id = oa.order_id
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
      INNER JOIN orders o ON o.order_id = oa.order_id
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
      INNER JOIN orders o ON o.order_id = odf.order_id
      WHERE o.black_state = 1 AND odf.device_fingerprint = ? LIMIT 20
    `,
      fingerprint
    );
    return rows as BlacklistHit[];
  }
}
