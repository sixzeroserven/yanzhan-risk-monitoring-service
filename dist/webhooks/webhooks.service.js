"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhooksService = void 0;
const common_1 = require("@nestjs/common");
const blacklist_service_1 = require("../blacklist/blacklist.service");
const shoplazza_service_1 = require("../shoplazza/shoplazza.service");
let WebhooksService = class WebhooksService {
    constructor(blacklistService, shoplazzaService) {
        this.blacklistService = blacklistService;
        this.shoplazzaService = shoplazzaService;
    }
    async processOrderCreate(order) {
        const orderId = (order.id || order.order_id || order.order_number);
        if (!orderId)
            throw new common_1.BadRequestException("Missing order id in payload");
        const result = await this.blacklistService.checkByOrder(order);
        if (!result.blocked)
            return { blocked: false, orderId };
        const hitTypes = [...new Set(result.hits.map((item) => item.hit_type))];
        const note = `Blacklist matched. Hit rules: ${hitTypes.join(", ")}. User has been marked as blacklisted.`;
        await this.shoplazzaService.appendOrderNote(orderId, note);
        await this.blacklistService.markOrderAsBlacklisted(order);
        return { blocked: true, orderId, hitCount: result.hits.length, hitTypes };
    }
};
exports.WebhooksService = WebhooksService;
exports.WebhooksService = WebhooksService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [blacklist_service_1.BlacklistService,
        shoplazza_service_1.ShoplazzaService])
], WebhooksService);
//# sourceMappingURL=webhooks.service.js.map