import { Body, Controller, Get, Headers, Logger, Post, Query, Req, UnauthorizedException } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { ShoplineService } from "../shopline/shopline.service";
import { extractOrderPayload } from "./webhook-order.util";
import { normalizeShoplineOrderForRisk } from "./shopline-order.util";
import { WebhooksService } from "./webhooks.service";

@ApiTags("webhooks")
@Controller("webhooks/shopline/orders")
export class ShoplineWebhooksController {
  private readonly logger = new Logger(ShoplineWebhooksController.name);

  constructor(
    private readonly shoplineService: ShoplineService,
    private readonly webhooksService: WebhooksService
  ) {}

  @Post("subscribe")
  @ApiOperation({ summary: "订阅 Shopline orders/create webhook" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        callback_url: {
          type: "string",
          example: "https://your-domain.com/webhooks/shopline/orders/create"
        },
        store_domain: { type: "string", example: "your-store.myshopline.com" }
      }
    }
  })
  async subscribe(@Body() body: Record<string, unknown>) {
    const storeDomain = String(body?.store_domain || body?.storeDomain || "");
    return this.shoplineService.subscribeOrderCreateWebhook(String(body?.callback_url || ""), storeDomain);
  }

  @Get("subscriptions")
  @ApiOperation({ summary: "列出当前 Shopline webhook 订阅" })
  @ApiQuery({ name: "storeDomain", description: "商店域名", required: false })
  async listSubscriptions(@Query("storeDomain") storeDomain?: string) {
    return this.shoplineService.listWebhooks(storeDomain);
  }

  @Post("subscriptions/cleanup")
  @ApiOperation({ summary: "清理 Shopline webhook 订阅（默认保留 orders/create）" })
  @ApiQuery({ name: "keepTopics", description: "可选：保留的 topic，多个 topic 用逗号分隔", required: false })
  @ApiQuery({ name: "storeDomain", description: "商店域名", required: false })
  async cleanupSubscriptions(@Query("keepTopics") keepTopics?: string, @Query("storeDomain") storeDomain?: string) {
    const topics = (keepTopics || "orders/create")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return this.shoplineService.cleanupWebhooks(topics, storeDomain);
  }

  @Post("create")
  @ApiOperation({ summary: "处理 Shopline orders/create webhook" })
  @ApiHeader({
    name: "x-shopline-hmac-sha256",
    required: false,
    description: "Shopline webhook HMAC 签名"
  })
  async handleOrderCreate(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>
  ) {
    return this.handleOrderWebhook("orders/create", req, body, headers);
  }

  @Post("update")
  @ApiOperation({ summary: "处理 Shopline orders/update webhook" })
  async handleOrderUpdate(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined>
  ) {
    return this.handleOrderWebhook("orders/update", req, body, headers);
  }

  private async handleOrderWebhook(
    topic: "orders/create" | "orders/update",
    req: Request & { rawBody?: Buffer },
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>
  ) {
    const payloadOrder = extractOrderPayload(body || {});
    const requestedStoreDomain = this.pickHeader(headers, "x-shopline-shop-domain", "x-shop-domain", "shop-domain") ||
      String(payloadOrder.shop_domain || payloadOrder.store_domain || body.shop_domain || body.store_domain || "");
    const signature = this.pickHeader(
      headers,
      "x-shopline-hmac-sha256",
      "x-shopline-signature",
      "x-shopline-webhook-signature",
      "x-hmac-sha256"
    );
    const verifiedStoreDomain = this.shoplineService.resolveVerifiedStoreDomain(
      req.rawBody as Buffer,
      signature,
      requestedStoreDomain
    );
    const signatureValid = !!verifiedStoreDomain;
    const orderId = String(payloadOrder.order_id || payloadOrder.id || payloadOrder.name || payloadOrder.order_number || "-");

    this.logger.log(
      `Shopline webhook inbound: topic=${topic} orderId=${orderId} requestedStore=${requestedStoreDomain || "-"} verifiedStore=${verifiedStoreDomain || "-"} hasRawBody=${String(!!req.rawBody)} hasSignature=${String(!!signature)} signatureValid=${String(signatureValid)}`
    );

    if (!signatureValid) {
      throw new UnauthorizedException("Shopline webhook 签名无效");
    }

    const store = this.shoplineService.findShoplineStore(verifiedStoreDomain);
    const normalizedOrder = normalizeShoplineOrderForRisk(
      payloadOrder,
      verifiedStoreDomain,
      store.orderIdPrefix || ""
    );
    return this.webhooksService.processOrderUpdate(normalizedOrder, verifiedStoreDomain, "shopline");
  }

  private pickHeader(headers: Record<string, string | string[] | undefined>, ...names: string[]): string {
    for (const name of names) {
      const value = headers[name.toLowerCase()] || headers[name];
      if (Array.isArray(value)) {
        const first = value.find((item) => String(item || "").trim());
        if (first) return String(first).trim();
      } else if (value) {
        return String(value).trim();
      }
    }
    return "";
  }
}
