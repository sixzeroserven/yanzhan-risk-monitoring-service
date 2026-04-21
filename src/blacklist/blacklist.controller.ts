import { Body, Controller, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { BlacklistService } from "./blacklist.service";

@ApiTags("blacklist")
@Controller("api/blacklist")
export class BlacklistController {
  constructor(private readonly blacklistService: BlacklistService) {}

  @Post("check")
  @ApiOperation({ summary: "Check whether input is blacklisted" })
  @ApiBody({
    schema: {
      type: "object",
      description:
        "Blacklist check uses email, phone_number, detail_address, address2, device_fingerprint. detail_address and address2 are matched independently (OR).",
      properties: {
        email: { type: "string", example: "risk.user@example.com" },
        phone_number: { type: "string", example: "14155551234" },
        detail_address: { type: "string", example: "123 Main Street" },
        address2: { type: "string", example: "Apt 6" },
        device_fingerprint: { type: "string", example: "fp_test_abc_001" },
        fingerprint: { type: "string", example: "fp_test_abc_001" },
        deviceFingerprint: { type: "string", example: "fp_test_abc_001" }
      }
    }
  })
  async check(@Body() body: Record<string, unknown>) {
    return this.blacklistService.checkByInput(body || {});
  }
}
