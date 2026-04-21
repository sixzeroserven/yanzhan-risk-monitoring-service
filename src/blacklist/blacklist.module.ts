import { Module } from "@nestjs/common";
import { BlacklistService } from "./blacklist.service";
import { BlacklistController } from "./blacklist.controller";
import { DatabaseModule } from "../database/database.module";

@Module({
  imports: [DatabaseModule],
  providers: [BlacklistService],
  controllers: [BlacklistController],
  exports: [BlacklistService]
})
export class BlacklistModule {}
