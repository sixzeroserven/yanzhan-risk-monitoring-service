import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { spawn } from "child_process";
import * as path from "path";

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  @Cron("40 15 * * *", { timeZone: "Asia/Shanghai" })
  runDailyCrawl(): void {
    const scriptPath = path.resolve(process.cwd(), "jobs", "crawl_orders.py");
    this.logger.log(`开始执行每日抓单脚本：${scriptPath}`);

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
      this.logger.error(`启动 crawl_orders.py 失败：${error.message}`);
    });

    child.on("close", (code) => {
      if (code === 0) {
        this.logger.log("crawl_orders.py 执行完成");
        return;
      }
      this.logger.error(`crawl_orders.py 异常退出，退出码：${String(code)}`);
    });
  }
}
