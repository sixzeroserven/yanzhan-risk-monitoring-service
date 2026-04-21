import { Module } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { EnvConfig } from "../common/config/env.config";

@Module({
  providers: [DatabaseService, EnvConfig],
  exports: [DatabaseService]
})
export class DatabaseModule {}
