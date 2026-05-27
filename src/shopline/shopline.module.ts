import { Module } from "@nestjs/common";
import { ShoplineService } from "./shopline.service";

@Module({
  providers: [ShoplineService],
  exports: [ShoplineService]
})
export class ShoplineModule {}
