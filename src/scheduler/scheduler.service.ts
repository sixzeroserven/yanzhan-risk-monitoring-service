import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { spawn } from "child_process";
import * as path from "path";

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  @Cron("00 18 * * *", { timeZone: "Asia/Shanghai" })
  runDailyCrawl(): void {
    this.runPythonJob("crawl_orders.py");
  }

  @Cron("30 19 * * *", { timeZone: "Asia/Shanghai" })
  runDailyHipaySync(): void {
    this.runPythonJob("sync_hipay_transaction_ids.py");
  }

  @Cron("00 20 * * *", { timeZone: "Asia/Shanghai" })
  runDailyShoplazzaOrderFieldsSync(): void {
    this.runPythonJob("sync_shoplazza_order_fields.py");
  }

  @Cron("30 20 * * *", { timeZone: "Asia/Shanghai" })
  runDailyShoplineOrderFieldsSync(): void {
    this.runPythonJob("sync_shopline_order_fields.py");
  }

  private runPythonJob(scriptFile: string): void {
    const scriptPath = path.resolve(process.cwd(), "jobs", scriptFile);
    this.logger.log(`开始执行脚本：${scriptPath}`);

    const child = spawn("python3", [scriptPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    const prefix = `[${scriptFile}]`;

    child.stdout.on("data", (data: Buffer) => {
      this.logger.log(`${prefix} ${data.toString().trim()}`);
    });

    child.stderr.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg.includes("ERROR") || msg.includes("CRITICAL")) {
        this.logger.error(`${prefix} ${msg}`);
      } else {
        this.logger.log(`${prefix} ${msg}`);
      }
    });

    child.on("error", (error) => {
      this.logger.error(`启动 ${scriptFile} 失败：${error.message}`);
    });

    child.on("close", (code) => {
      if (code === 0) {
        this.logger.log(`${scriptFile} 执行完成`);
        return;
      }
      this.logger.error(`${scriptFile} 异常退出，退出码：${String(code)}`);
    });
  }
}
