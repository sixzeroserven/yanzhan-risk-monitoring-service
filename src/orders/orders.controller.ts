import { Body, Controller, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { OrdersService } from "./orders.service";

@ApiTags("orders")
@Controller("api/orders")
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post("save")
  @ApiOperation({ summary: "Save order address data; optionally save blacklist record" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["order_id", "device_fingerprint"],
      properties: {
        order_id: { type: "string", example: "ORDER_10001" },
        device_fingerprint: { type: "string", example: "fp_test_abc_001" },
        fingerprint: { type: "string", example: "fp_test_abc_001" },
        deviceFingerprint: { type: "string", example: "fp_test_abc_001" }
      }
    }
  })
  async save(@Body() body: Record<string, unknown>) {
    return this.ordersService.saveOrder(body || {});
  }
}
