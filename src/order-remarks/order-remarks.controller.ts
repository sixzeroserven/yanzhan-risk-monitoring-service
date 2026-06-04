import { Body, Controller, ForbiddenException, Headers, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { OrderRemarkLookupRequest, OrderRemarksService } from "./order-remarks.service";

@ApiTags("order-remarks")
@Controller("api/order-remarks")
export class OrderRemarksController {
  constructor(private readonly orderRemarksService: OrderRemarksService) {}

  @Post("shopline")
  @ApiOperation({ summary: "Batch lookup Shopline customer_note by platform order ids" })
  async lookupShoplineRemarks(
    @Body() body: Record<string, unknown>,
    @Headers("x-order-remark-token") token?: string
  ) {
    this.verifyToken(token);
    const orders = this.parseOrderRequests(body);
    const data = await this.orderRemarksService.lookupShoplineCustomerNotes(orders);
    return {
      success: true,
      count: Object.keys(data).length,
      data
    };
  }

  @Post("shoplazza")
  @ApiOperation({ summary: "Batch lookup Shoplazza risk note by platform order ids" })
  async lookupShoplazzaRemarks(
    @Body() body: Record<string, unknown>,
    @Headers("x-order-remark-token") token?: string
  ) {
    this.verifyToken(token);
    const orders = this.parseOrderRequests(body);
    const data = await this.orderRemarksService.lookupShoplazzaOrderRemarks(orders);
    return {
      success: true,
      count: Object.keys(data).length,
      data
    };
  }

  private verifyToken(token?: string): void {
    const expected = String(process.env.ORDER_REMARK_LOOKUP_TOKEN || "").trim();
    if (!expected) return;
    if (String(token || "").trim() !== expected) {
      throw new ForbiddenException("Invalid order remark lookup token");
    }
  }

  private parseOrderRequests(body: Record<string, unknown>): OrderRemarkLookupRequest[] {
    const fromRows = this.parseOrderRows(body?.orders);
    if (fromRows.length > 0) return fromRows;
    return this.parseOrderIds(body?.orderIds).map((orderId) => ({ orderId }));
  }

  private parseOrderRows(value: unknown): OrderRemarkLookupRequest[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: OrderRemarkLookupRequest[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const orderId = this.parseOrderId(row.orderId || row.id);
      if (!orderId) continue;
      const storeDomain = this.cleanStoreHint(row.storeDomain || row.store_domain || row.domain);
      const storeName = this.cleanStoreHint(row.storeName || row.store_name || row.store || row.storeHandle);
      const key = `${orderId}|${storeDomain}|${storeName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ orderId, storeDomain, storeName });
      if (out.length >= 500) break;
    }
    return out;
  }

  private parseOrderIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim())
          .filter((item) => item && /^\d{10,40}$/.test(item))
      )
    ).slice(0, 500);
  }

  private parseOrderId(value: unknown): string {
    const text = String(value || "").trim();
    return /^\d{10,40}$/.test(text) ? text : "";
  }

  private cleanStoreHint(value: unknown): string {
    return String(value || "")
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 120);
  }
}
