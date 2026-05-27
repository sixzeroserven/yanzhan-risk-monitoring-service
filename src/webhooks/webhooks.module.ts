import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { ShoplineWebhooksController } from "./shopline-webhooks.controller";
import { WebhooksService } from "./webhooks.service";
import { BlacklistModule } from "../blacklist/blacklist.module";
import { ShoplazzaModule } from "../shoplazza/shoplazza.module";
import { ShoplineModule } from "../shopline/shopline.module";

@Module({
  imports: [BlacklistModule, ShoplazzaModule, ShoplineModule],
  controllers: [WebhooksController, ShoplineWebhooksController],
  providers: [WebhooksService]
})
export class WebhooksModule {}
