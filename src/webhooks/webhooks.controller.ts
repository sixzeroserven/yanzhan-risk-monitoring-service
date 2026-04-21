import { Body, Controller, Headers, Post, Req, UnauthorizedException } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { ShoplazzaService } from "../shoplazza/shoplazza.service";
import { WebhooksService } from "./webhooks.service";

@ApiTags("webhooks")
@Controller("webhooks/shoplazza/orders")
export class WebhooksController {
  constructor(
    private readonly shoplazzaService: ShoplazzaService,
    private readonly webhooksService: WebhooksService
  ) {}

  @Post("create")
  @ApiOperation({ summary: "Handle Shoplazza orders/create webhook" })
  @ApiHeader({
    name: "x-shoplazza-hmac-sha256",
    required: true,
    description: "Webhook HMAC signature"
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
        order_id: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
        order_number: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
        email: { type: "string", example: "risk.user@example.com" },
        phone: { type: "string", example: "+1 415-555-1234" },
        shipping_address: {
          type: "object",
          description: "Blacklist uses phone and address2 only here (not mobile, address1, city, etc.).",
          properties: {
            name: { type: "string", example: "Risk User" },
            phone: { type: "string", example: "+1 415-555-1234" },
            address2: { type: "string", example: "Apt 6" }
          }
        },
        billing_address: {
          type: "object",
          description: "Blacklist uses phone and address2 only here (not mobile, address1, city, etc.).",
          properties: {
            name: { type: "string", example: "Risk User" },
            phone: { type: "string", example: "+1 415-555-1234" },
            address2: { type: "string", example: "Apt 6" }
          }
        },
        note_attributes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", example: "device_fingerprint" },
              value: { type: "string", example: "fp_test_abc_001" }
            }
          }
        },
        device_fingerprint: { type: "string", example: "fp_test_abc_001" }
      }
    }
  })
  async handleOrderCreate(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: Record<string, unknown>,
    @Headers("x-shoplazza-hmac-sha256") hmac?: string
  ) {
    if (!this.shoplazzaService.verifyWebhookSignature(req.rawBody as Buffer, hmac)) {
      throw new UnauthorizedException("Invalid webhook signature");
    }
    return this.webhooksService.processOrderCreate(body || {});
  }
}
