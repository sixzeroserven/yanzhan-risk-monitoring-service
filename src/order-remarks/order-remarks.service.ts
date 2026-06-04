import { Injectable } from "@nestjs/common";
import { ShoplazzaOrderRemarkRequest, ShoplazzaService } from "../shoplazza/shoplazza.service";
import { ShoplineCustomerNoteRequest, ShoplineService } from "../shopline/shopline.service";

export type CustomerNoteResponse = {
  customer_note: string;
  storeDomain: string;
};

export type OrderRemarkLookupRequest = ShoplineCustomerNoteRequest;

@Injectable()
export class OrderRemarksService {
  constructor(
    private readonly shoplineService: ShoplineService,
    private readonly shoplazzaService: ShoplazzaService
  ) {}

  async lookupShoplineCustomerNotes(
    orders: OrderRemarkLookupRequest[]
  ): Promise<Record<string, CustomerNoteResponse>> {
    const rows = await this.shoplineService.lookupCustomerNotesForOrders(orders);
    const out: Record<string, CustomerNoteResponse> = {};
    for (const [orderId, row] of Object.entries(rows)) {
      if (!row.customer_note) continue;
      out[orderId] = {
        customer_note: row.customer_note,
        storeDomain: row.storeDomain
      };
    }
    return out;
  }

  async lookupShoplazzaOrderRemarks(
    orders: ShoplazzaOrderRemarkRequest[]
  ): Promise<Record<string, CustomerNoteResponse>> {
    const rows = await this.shoplazzaService.lookupOrderRemarksForOrders(orders);
    const out: Record<string, CustomerNoteResponse> = {};
    for (const [orderId, row] of Object.entries(rows)) {
      if (!row.customer_note) continue;
      out[orderId] = {
        customer_note: row.customer_note,
        storeDomain: row.storeDomain
      };
    }
    return out;
  }
}
