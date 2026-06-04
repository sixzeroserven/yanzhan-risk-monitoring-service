import { Module } from "@nestjs/common";
import { ShoplazzaModule } from "../shoplazza/shoplazza.module";
import { ShoplineModule } from "../shopline/shopline.module";
import { OrderRemarksController } from "./order-remarks.controller";
import { OrderRemarksService } from "./order-remarks.service";

@Module({
  imports: [ShoplineModule, ShoplazzaModule],
  controllers: [OrderRemarksController],
  providers: [OrderRemarksService]
})
export class OrderRemarksModule {}
