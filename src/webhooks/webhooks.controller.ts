import { Body, Controller, Get, Headers, Logger, Post, Query, Req, UnauthorizedException } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { ShoplazzaService } from "../shoplazza/shoplazza.service";
import { extractOrderPayload } from "./webhook-order.util";
import { WebhooksService } from "./webhooks.service";

@ApiTags("webhooks")
@Controller("webhooks/shoplazza/orders")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);
  constructor(
    private readonly shoplazzaService: ShoplazzaService,
    private readonly webhooksService: WebhooksService
  ) {}

  @Post("subscribe")
  @ApiOperation({ summary: "订阅 Shoplazza orders/update webhook" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        callback_url: {
          type: "string",
          example: "https://your-domain.com/webhooks/shoplazza/orders/update"
        }
      }
    }
  })
  async subscribe(@Body() body: Record<string, unknown>) {
    const storeDomain = String(body?.store_domain || body?.storeDomain || "");
    return this.shoplazzaService.subscribeOrderUpdateWebhook(String(body?.callback_url || ""), storeDomain);
  }

  @Get("subscriptions")
  @ApiOperation({ summary: "列出当前 Shoplazza webhook 订阅" })
  @ApiQuery({ name: "storeDomain", description: "商店域名", required: false })
  async listSubscriptions(@Query("storeDomain") storeDomain?: string) {
    return this.shoplazzaService.listWebhooks(storeDomain);
  }

  @Post("subscriptions/cleanup")
  @ApiOperation({ summary: "清理 webhook 订阅（默认清空所有订阅）" })
  @ApiQuery({ name: "keepTopics", description: "可选：保留的 topic，多个 topic 用逗号分隔", required: false })
  @ApiQuery({ name: "storeDomain", description: "商店域名", required: false })
  async cleanupSubscriptions(@Query("keepTopics") keepTopics?: string, @Query("storeDomain") storeDomain?: string) {
    const topics = (keepTopics || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return this.shoplazzaService.cleanupWebhooks(topics, storeDomain);
  }

  @Post("update")
  @ApiOperation({ summary: "处理 Shoplazza orders/update webhook" })
  @ApiHeader({
    name: "x-shoplazza-hmac-sha256",
    required: true,
    description: "Webhook HMAC 签名"
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
        order_id: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
        order_number: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" }
      }
    }
  })
  async handleOrderUpdate(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: Record<string, unknown>,
    @Headers("x-shoplazza-hmac-sha256") hmac?: string,
    @Headers("x-shoplazza-shop-domain") shopDomain?: string,
    @Headers("x-shop-domain") fallbackShopDomain?: string
  ) {
    return this.handleOrderWebhook("orders/update", req, body, hmac, shopDomain, fallbackShopDomain);
  }

  @Post("create")
  @ApiOperation({ summary: "处理 Shoplazza orders/create webhook" })
  @ApiHeader({
    name: "x-shoplazza-hmac-sha256",
    required: true,
    description: "Webhook HMAC 签名"
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
        order_id: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
        order_number: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" }
      }
    }
  })
  async handleOrderCreate(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: Record<string, unknown>,
    @Headers("x-shoplazza-hmac-sha256") hmac?: string,
    @Headers("x-shoplazza-shop-domain") shopDomain?: string,
    @Headers("x-shop-domain") fallbackShopDomain?: string
  ) {
    return this.handleOrderWebhook("orders/create", req, body, hmac, shopDomain, fallbackShopDomain);
  }

  private async handleOrderWebhook(
    topic: "orders/create" | "orders/update",
    req: Request & { rawBody?: Buffer },
    body: Record<string, unknown>,
    hmac?: string,
    shopDomain?: string,
    fallbackShopDomain?: string
  ) {
    const payloadOrder = extractOrderPayload(body || {});
    const payloadDomain = String(
      payloadOrder.shop_domain || payloadOrder.store_domain || body.shop_domain || body.store_domain || ""
    );
    const requestedStoreDomain = String(shopDomain || fallbackShopDomain || payloadDomain || "");
    const orderId = String(
      payloadOrder.order_id ||
        payloadOrder.id ||
        payloadOrder.source_id ||
        payloadOrder.order_number ||
        payloadOrder.number ||
        "-"
    );
    const hasRawBody = !!req.rawBody;
    const verifiedStoreDomain = this.shoplazzaService.resolveVerifiedStoreDomain(
      req.rawBody as Buffer,
      hmac,
      requestedStoreDomain
    );
    const signatureValid = !!verifiedStoreDomain;

    this.logger.log(
      `Webhook inbound: topic=${topic} orderId=${orderId} requestedStore=${requestedStoreDomain || "-"} verifiedStore=${verifiedStoreDomain || "-"} hasRawBody=${String(hasRawBody)} hasHmac=${String(!!hmac)} signatureValid=${String(signatureValid)}`
    );

    if (!signatureValid) {
      throw new UnauthorizedException("Webhook 签名无效");
    }
    return this.webhooksService.processOrderUpdate(payloadOrder, verifiedStoreDomain);
  }
}
