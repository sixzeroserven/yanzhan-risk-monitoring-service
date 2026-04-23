import { Body, Controller, Get, Headers, Post, Query, Req, UnauthorizedException } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { ShoplazzaService } from "../shoplazza/shoplazza.service";
import { extractOrderPayload } from "./webhook-order.util";
import { WebhooksService } from "./webhooks.service";

@ApiTags("webhooks")
@Controller("webhooks/shoplazza/orders")
export class WebhooksController {
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
    return this.shoplazzaService.subscribeOrderUpdateWebhook(String(body?.callback_url || ""));
  }

  @Get("subscriptions")
  @ApiOperation({ summary: "列出当前 Shoplazza webhook 订阅" })
  async listSubscriptions() {
    return this.shoplazzaService.listWebhooks();
  }

  @Post("subscriptions/cleanup")
  @ApiOperation({ summary: "清理非保留 topic 的 webhook 订阅（默认保留 orders/update）" })
  @ApiQuery({ name: "keepTopics", description: "保留的 topic，多个 topic 用逗号分隔", required: false })
  async cleanupSubscriptions(@Query("keepTopics") keepTopics?: string) {
    const topics = (keepTopics || "orders/update")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return this.shoplazzaService.cleanupWebhooks(topics);
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
    @Headers("x-shoplazza-hmac-sha256") hmac?: string
  ) {
    if (!this.shoplazzaService.verifyWebhookSignature(req.rawBody as Buffer, hmac)) {
      throw new UnauthorizedException("Webhook 签名无效");
    }
    const order = extractOrderPayload(body || {});
    return this.webhooksService.processOrderUpdate(order);
  }
}
