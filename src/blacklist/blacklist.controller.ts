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
        "Blacklist check uses email, phone_number, detail_address, device_fingerprint.",
      properties: {
        email: { type: "string", example: "risk.user@example.com" },
        phone_number: { type: "string", example: "14155551234" },
        detail_address: { type: "string", example: "123 Main Street" },
        device_fingerprint: { type: "string", example: "fp_test_abc_001" },
        fingerprint: { type: "string", example: "fp_test_abc_001" },
        deviceFingerprint: { type: "string", example: "fp_test_abc_001" }
      }
    }
  })
  async check(@Body() body: Record<string, unknown>) {
    return this.blacklistService.checkByInput(body || {});
  }

  @Post("score")
  @ApiOperation({ summary: "Score user risk by email when not excluded by blacklist/disputes/email rules" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        email: { type: "string", example: "buyer@example.com" }
      },
      required: ["email"]
    }
  })
  async score(@Body() body: Record<string, unknown>) {
    return this.blacklistService.scoreByInput(body || {});
  }

  @Post("email-risk/check")
  @ApiOperation({ summary: "Batch check email blacklist, dispute, risk score, and shipping decision" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        email: { type: "string", example: "buyer@example.com" },
        emails: {
          type: "array",
          items: { type: "string" },
          example: ["buyer@example.com", "risk.user@example.com"]
        }
      }
    }
  })
  async checkEmailRisk(@Body() body: Record<string, unknown>) {
    return this.blacklistService.checkEmailRiskByInput(body || {});
  }
}
