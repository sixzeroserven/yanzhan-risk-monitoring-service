import { BadRequestException, Injectable } from "@nestjs/common";
import { BlacklistService } from "../blacklist/blacklist.service";
import { ShoplazzaService } from "../shoplazza/shoplazza.service";

@Injectable()
export class WebhooksService {
  constructor(
    private readonly blacklistService: BlacklistService,
    private readonly shoplazzaService: ShoplazzaService
  ) {}

  async processOrderCreate(order: Record<string, unknown>) {
    const orderId = (order.id || order.order_id || order.order_number) as string | number;
    if (!orderId) throw new BadRequestException("Missing order id in payload");

    const result = await this.blacklistService.checkByOrder(order);
    if (!result.blocked) return { blocked: false, orderId };

    const hitTypes = [...new Set(result.hits.map((item: { hit_type: string }) => item.hit_type))];
    const note = `Blacklist matched. Hit rules: ${hitTypes.join(", ")}. User has been marked as blacklisted.`;

    await this.shoplazzaService.appendOrderNote(orderId, note);
    await this.blacklistService.markOrderAsBlacklisted(order);

    return { blocked: true, orderId, hitCount: result.hits.length, hitTypes };
  }
}
