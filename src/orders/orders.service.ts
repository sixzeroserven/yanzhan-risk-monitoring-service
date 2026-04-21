import { BadRequestException, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { safeString } from "../common/utils/normalize.util";

@Injectable()
export class OrdersService {
  constructor(private readonly db: DatabaseService) {}

  async saveOrder(body: Record<string, unknown>) {
    const orderId = safeString(body.order_id || body.id || body.orderId);
    if (!orderId) throw new BadRequestException("order_id is required");

    const deviceFingerprint = safeString(body.device_fingerprint || body.fingerprint || body.deviceFingerprint);
    if (!deviceFingerprint) {
      throw new BadRequestException("device_fingerprint is required");
    }

    // saveOrder now only maintains the order-device fingerprint mapping.
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

    return { success: true, order_id: orderId, device_fingerprint_saved: true };
  }
}
