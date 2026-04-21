"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlacklistService = void 0;
const common_1 = require("@nestjs/common");
const database_service_1 = require("../database/database.service");
const normalize_util_1 = require("../common/utils/normalize.util");
let BlacklistService = class BlacklistService {
    constructor(db) {
        this.db = db;
    }
    async checkByInput(input) {
        const contact = {
            email: (0, normalize_util_1.normalizeEmail)(input.email),
            phoneNumber: (0, normalize_util_1.normalizePhone)(input.phone_number),
            detailAddress: (0, normalize_util_1.normalizeAddress)(input.detail_address),
            address2: (0, normalize_util_1.normalizeAddress)(input.address2),
            fingerprint: (0, normalize_util_1.safeString)(input.device_fingerprint || input.fingerprint || input.deviceFingerprint)
        };
        return this.checkByContact(contact);
    }
    async checkByOrder(order) {
        const shipping = order.shipping_address || {};
        const billing = order.billing_address || {};
        const contact = {
            email: (0, normalize_util_1.normalizeEmail)(order.email),
            phoneNumber: (0, normalize_util_1.normalizePhone)(order.phone_number || shipping.phone || billing.phone || order.phone),
            detailAddress: (0, normalize_util_1.normalizeAddress)(shipping.detail_address || billing.detail_address),
            address2: (0, normalize_util_1.normalizeAddress)(shipping.address2 || billing.address2),
            fingerprint: (0, normalize_util_1.safeString)((0, normalize_util_1.getDeviceFingerprint)(order))
        };
        return this.checkByContact(contact);
    }
    async markOrderAsBlacklisted(order) {
        const orderId = (0, normalize_util_1.safeString)(order.id || order.order_id || order.order_number);
        if (!orderId)
            return;
        const shipping = order.shipping_address || {};
        const billing = order.billing_address || {};
        const customer = order.customer || {};
        await this.db.orderAddress.upsert({
            where: { orderId },
            create: {
                orderId,
                sourceId: (0, normalize_util_1.safeString)(order.source_id || order.source),
                phoneNumber: (0, normalize_util_1.safeString)(order.phone),
                country: (0, normalize_util_1.safeString)(shipping.country || billing.country),
                province: (0, normalize_util_1.safeString)(shipping.province || billing.province),
                city: (0, normalize_util_1.safeString)(shipping.city || billing.city),
                district: (0, normalize_util_1.safeString)(shipping.district || billing.district),
                contactPerson: (0, normalize_util_1.safeString)(shipping.name ||
                    billing.name ||
                    customer.name ||
                    `${(0, normalize_util_1.safeString)(customer.first_name)} ${(0, normalize_util_1.safeString)(customer.last_name)}`.trim()),
                mobile: (0, normalize_util_1.normalizePhone)(shipping.phone || billing.phone || order.phone),
                detailAddress: (0, normalize_util_1.safeString)(shipping.address1 || billing.address1 || shipping.address || billing.address),
                address2: (0, normalize_util_1.safeString)(shipping.address2 || billing.address2),
                email: (0, normalize_util_1.normalizeEmail)(order.email || customer.email)
            },
            update: {
                sourceId: (0, normalize_util_1.safeString)(order.source_id || order.source),
                phoneNumber: (0, normalize_util_1.safeString)(order.phone),
                country: (0, normalize_util_1.safeString)(shipping.country || billing.country),
                province: (0, normalize_util_1.safeString)(shipping.province || billing.province),
                city: (0, normalize_util_1.safeString)(shipping.city || billing.city),
                district: (0, normalize_util_1.safeString)(shipping.district || billing.district),
                contactPerson: (0, normalize_util_1.safeString)(shipping.name ||
                    billing.name ||
                    customer.name ||
                    `${(0, normalize_util_1.safeString)(customer.first_name)} ${(0, normalize_util_1.safeString)(customer.last_name)}`.trim()),
                mobile: (0, normalize_util_1.normalizePhone)(shipping.phone || billing.phone || order.phone),
                detailAddress: (0, normalize_util_1.safeString)(shipping.address1 || billing.address1 || shipping.address || billing.address),
                address2: (0, normalize_util_1.safeString)(shipping.address2 || billing.address2),
                email: (0, normalize_util_1.normalizeEmail)(order.email || customer.email)
            }
        });
        const packageNumber = (0, normalize_util_1.safeString)(order.package_number || order.packageNumber || order.name || orderId);
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
                buyerName: (0, normalize_util_1.safeString)(customer.name || order.customer_name),
                contactName: (0, normalize_util_1.safeString)(shipping.name || billing.name || customer.name),
                buyerAccount: (0, normalize_util_1.safeString)(customer.email || order.email),
                buyerCountry: (0, normalize_util_1.safeString)(shipping.country || billing.country),
                blackState: true
            },
            update: {
                packageNumber,
                buyerName: (0, normalize_util_1.safeString)(customer.name || order.customer_name),
                contactName: (0, normalize_util_1.safeString)(shipping.name || billing.name || customer.name),
                buyerAccount: (0, normalize_util_1.safeString)(customer.email || order.email),
                buyerCountry: (0, normalize_util_1.safeString)(shipping.country || billing.country),
                blackState: true
            }
        });
        const deviceFingerprint = (0, normalize_util_1.safeString)((0, normalize_util_1.getDeviceFingerprint)(order));
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
    async checkByContact(contact) {
        const blacklistedOrders = await this.getBlacklistedOrders();
        if (!blacklistedOrders.length)
            return { blocked: false, contact, hits: [] };
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
    async getBlacklistedOrders() {
        const rows = await this.db.$queryRawUnsafe(`
      SELECT o.id, o.order_id, o.package_number
      FROM orders o
      WHERE o.black_state = 1
    `);
        return rows;
    }
    async findByEmail(email) {
        if (!email)
            return [];
        const rows = await this.db.$queryRawUnsafe(`
      SELECT o.id, o.order_id, o.package_number, 'email' AS hit_type, oa.email AS hit_value
      FROM order_address oa
      INNER JOIN orders o ON o.order_id = oa.order_id
      WHERE o.black_state = 1
        AND LOWER(TRIM(oa.email)) = ?
      LIMIT 20
    `, email);
        return rows;
    }
    async findByPhoneNumber(phoneNumber) {
        if (!phoneNumber)
            return [];
        const phoneLike = `%${phoneNumber}%`;
        const rows = await this.db.$queryRawUnsafe(`
      SELECT o.id, o.order_id, o.package_number, 'phone_number' AS hit_type, oa.phone_number AS hit_value
       FROM order_address oa
       INNER JOIN orders o ON o.order_id = oa.order_id
       WHERE o.black_state = 1
         AND REPLACE(REPLACE(REPLACE(COALESCE(oa.phone_number, ''), ' ', ''), '-', ''), '(', '') LIKE ?
       LIMIT 20
    `, phoneLike);
        return rows;
    }
    async findByDetailAddress(detailAddress) {
        if (!detailAddress)
            return [];
        const addressLike = `%${detailAddress}%`;
        const rows = await this.db.$queryRawUnsafe(`
      SELECT o.id, o.order_id, o.package_number, 'detail_address' AS hit_type, oa.detail_address AS hit_value
       FROM order_address oa
       INNER JOIN orders o ON o.order_id = oa.order_id
       WHERE o.black_state = 1
         AND LOWER(TRIM(COALESCE(oa.detail_address, ''))) LIKE ?
       LIMIT 20
    `, addressLike);
        return rows;
    }
    async findByAddress2(address2) {
        if (!address2)
            return [];
        const address2Like = `%${address2}%`;
        const rows = await this.db.$queryRawUnsafe(`
      SELECT o.id, o.order_id, o.package_number, 'address2' AS hit_type, oa.address2 AS hit_value
      FROM order_address oa
      INNER JOIN orders o ON o.order_id = oa.order_id
      WHERE o.black_state = 1
        AND LOWER(TRIM(COALESCE(oa.address2, ''))) LIKE ?
      LIMIT 20
    `, address2Like);
        return rows;
    }
    async findByFingerprint(fingerprint) {
        if (!fingerprint)
            return [];
        const rows = await this.db.$queryRawUnsafe(`
      SELECT o.id, o.order_id, o.package_number, 'device_fingerprint' AS hit_type, odf.device_fingerprint AS hit_value
      FROM order_device_fingerprint odf
      INNER JOIN orders o ON o.order_id = odf.order_id
      WHERE o.black_state = 1 AND odf.device_fingerprint = ? LIMIT 20
    `, fingerprint);
        return rows;
    }
};
exports.BlacklistService = BlacklistService;
exports.BlacklistService = BlacklistService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService])
], BlacklistService);
//# sourceMappingURL=blacklist.service.js.map