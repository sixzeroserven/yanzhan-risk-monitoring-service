import { Module } from "@nestjs/common";
import { ShoplazzaService } from "./shoplazza.service";
import { EnvConfig } from "../common/config/env.config";

@Module({
  providers: [ShoplazzaService, EnvConfig],
  exports: [ShoplazzaService]
})
export class ShoplazzaModule {}
