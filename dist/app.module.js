"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const env_config_1 = require("./common/config/env.config");
const health_controller_1 = require("./health.controller");
const database_module_1 = require("./database/database.module");
const blacklist_module_1 = require("./blacklist/blacklist.module");
const orders_module_1 = require("./orders/orders.module");
const shoplazza_module_1 = require("./shoplazza/shoplazza.module");
const webhooks_module_1 = require("./webhooks/webhooks.module");
const scheduler_module_1 = require("./scheduler/scheduler.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [database_module_1.DatabaseModule, blacklist_module_1.BlacklistModule, orders_module_1.OrdersModule, shoplazza_module_1.ShoplazzaModule, webhooks_module_1.WebhooksModule, scheduler_module_1.SchedulerModule],
        controllers: [health_controller_1.HealthController],
        providers: [env_config_1.EnvConfig]
    })
], AppModule);
//# sourceMappingURL=app.module.js.map