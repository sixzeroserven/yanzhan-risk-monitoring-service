import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

@ApiTags("health")
@Controller()
export class HealthController {
  @Get("/health")
  @ApiOperation({ summary: "Service health check" })
  health(): { ok: boolean } {
    return { ok: true };
  }
}
