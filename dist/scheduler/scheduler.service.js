"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var SchedulerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulerService = void 0;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
let SchedulerService = SchedulerService_1 = class SchedulerService {
    constructor() {
        this.logger = new common_1.Logger(SchedulerService_1.name);
    }
    runDailyCrawl() {
        const scriptPath = path.resolve(process.cwd(), "jobs", "crawl_orders.py");
        this.logger.log(`Running daily crawl script: ${scriptPath}`);
        const child = (0, child_process_1.spawn)("python3", [scriptPath], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", (data) => {
            this.logger.log(`[crawl_orders.py] ${data.toString().trim()}`);
        });
        child.stderr.on("data", (data) => {
            const msg = data.toString().trim();
            if (msg.includes("ERROR") || msg.includes("CRITICAL")) {
                this.logger.error(`[crawl_orders.py] ${msg}`);
            }
            else {
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
};
exports.SchedulerService = SchedulerService;
__decorate([
    (0, schedule_1.Cron)("0 1 * * *", { timeZone: "Asia/Shanghai" }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SchedulerService.prototype, "runDailyCrawl", null);
exports.SchedulerService = SchedulerService = SchedulerService_1 = __decorate([
    (0, common_1.Injectable)()
], SchedulerService);
//# sourceMappingURL=scheduler.service.js.map