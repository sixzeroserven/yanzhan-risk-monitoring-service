import { Module } from "@nestjs/common";
import { EnvConfig } from "./common/config/env.config";
import { HealthController } from "./health.controller";
import { DatabaseModule } from "./database/database.module";
import { BlacklistModule } from "./blacklist/blacklist.module";
import { OrdersModule } from "./orders/orders.module";
import { ShoplazzaModule } from "./shoplazza/shoplazza.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { SchedulerModule } from "./scheduler/scheduler.module";
import { OrderRemarksModule } from "./order-remarks/order-remarks.module";

@Module({
  imports: [
    DatabaseModule,
    BlacklistModule,
    OrdersModule,
    ShoplazzaModule,
    WebhooksModule,
    SchedulerModule,
    OrderRemarksModule
  ],
  controllers: [HealthController],
  providers: [EnvConfig]
})
export class AppModule {}
