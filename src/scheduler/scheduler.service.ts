import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { spawn } from "child_process";
import * as path from "path";

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly runningJobs = new Set<string>();

  // @Cron("00 18 * * *", { timeZone: "Asia/Shanghai" })
  // runDailyCrawl(): void {
  //   this.runPythonJob("crawl_orders.py");
  // }

  @Cron("00 18 * * *", { timeZone: "Asia/Shanghai" })
  runDailyPlatformOrdersBaseSync(): void {
    this.runPythonJob("sync_platform_orders_base.py", [
      "--platform",
      "all",
      "--since-days",
      "3"
    ]);
  }

  @Cron("00 19 * * *", { timeZone: "Asia/Shanghai" })
  runDailyMabangBlackStateSync(): void {
    this.runPythonJob("sync_mabang_black_state.py", [
      "--since-days",
      "3"
    ]);
  }

  @Cron("00 20 * * *", { timeZone: "Asia/Shanghai" })
  runDailyHipaySync(): void {
    this.runPythonJob("sync_hipay_transaction_ids.py");
  }

  // @Cron("00 20 * * *", { timeZone: "Asia/Shanghai" })
  // runDailyShoplazzaOrderFieldsSync(): void {
  //   this.runPythonJob("sync_shoplazza_order_fields.py");
  // }

  // @Cron("30 20 * * *", { timeZone: "Asia/Shanghai" })
  // runDailyShoplineOrderFieldsSync(): void {
  //   this.runPythonJob("sync_shopline_order_fields.py");
  // }

  @Cron(process.env.PAYPAL_DISPUTE_SYNC_CRON || "50 21 * * *", { timeZone: "Asia/Shanghai" })
  runDailyPaypalDisputesSync(): void {
    this.runPythonJob("sync_paypal_disputes.py", ["--lookback-days", "7", "--fetch-detail"]);
  }

  @Cron(process.env.PAYPAL_REPORTING_SYNC_CRON || "20 23 * * *", { timeZone: "Asia/Shanghai" })
  runDailyPaypalReportingSync(): void {
    this.runPythonJob("sync_paypal_reporting_transactions.py", ["--lookback-days", "7"]);
  }

  private runPythonJob(scriptFile: string, args: string[] = []): void {
    const jobKey = `${scriptFile} ${args.join(" ")}`.trim();
    if (this.runningJobs.has(jobKey)) {
      this.logger.warn(`脚本仍在执行中，跳过本次调度：${jobKey}`);
      return;
    }

    const scriptPath = path.resolve(process.cwd(), "jobs", scriptFile);
    this.runningJobs.add(jobKey);
    this.logger.log(`开始执行脚本：${scriptPath}${args.length > 0 ? ` ${args.join(" ")}` : ""}`);

    const child = spawn("python3", [scriptPath, ...args], {
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
      this.runningJobs.delete(jobKey);
      this.logger.error(`启动 ${scriptFile} 失败：${error.message}`);
    });

    child.on("close", (code) => {
      this.runningJobs.delete(jobKey);
      if (code === 0) {
        this.logger.log(`${scriptFile} 执行完成`);
        return;
      }
      this.logger.error(`${scriptFile} 异常退出，退出码：${String(code)}`);
    });
  }
}
