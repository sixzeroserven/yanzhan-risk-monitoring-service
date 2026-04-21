import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { spawn } from "child_process";
import * as path from "path";

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  @Cron("01 15 * * *", { timeZone: "Asia/Shanghai" })
  runDailyCrawl(): void {
    const scriptPath = path.resolve(process.cwd(), "jobs", "crawl_orders.py");
    this.logger.log(`Running daily crawl script: ${scriptPath}`);

    const child = spawn("python3", [scriptPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (data: Buffer) => {
      this.logger.log(`[crawl_orders.py] ${data.toString().trim()}`);
    });

    child.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg.includes("ERROR") || msg.includes("CRITICAL")) {
        this.logger.error(`[crawl_orders.py] ${msg}`);
      } else {
        this.logger.log(`[crawl_orders.py] ${msg}`);
      }
    });

    child.on("error", (error) => {
      this.logger.error(`Failed to start crawl_orders.py: ${error.message}`);
    });

    child.on("close", (code) => {
      if (code === 0) {
        this.logger.log("crawl_orders.py completed successfully");
        return;
      }
      this.logger.error(`crawl_orders.py exited with code ${String(code)}`);
    });
  }
}
