import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { BlacklistModule } from "../blacklist/blacklist.module";
import { ShoplazzaModule } from "../shoplazza/shoplazza.module";

@Module({
  imports: [BlacklistModule, ShoplazzaModule],
  controllers: [WebhooksController],
  providers: [WebhooksService]
})
export class WebhooksModule {}
