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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhooksController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const shoplazza_service_1 = require("../shoplazza/shoplazza.service");
const webhooks_service_1 = require("./webhooks.service");
let WebhooksController = class WebhooksController {
    constructor(shoplazzaService, webhooksService) {
        this.shoplazzaService = shoplazzaService;
        this.webhooksService = webhooksService;
    }
    async handleOrderCreate(req, body, hmac) {
        if (!this.shoplazzaService.verifyWebhookSignature(req.rawBody, hmac)) {
            throw new common_1.UnauthorizedException("Invalid webhook signature");
        }
        return this.webhooksService.processOrderCreate(body || {});
    }
};
exports.WebhooksController = WebhooksController;
__decorate([
    (0, common_1.Post)("create"),
    (0, swagger_1.ApiOperation)({ summary: "Handle Shoplazza orders/create webhook" }),
    (0, swagger_1.ApiHeader)({
        name: "x-shoplazza-hmac-sha256",
        required: true,
        description: "Webhook HMAC signature"
    }),
    (0, swagger_1.ApiBody)({
        schema: {
            type: "object",
            required: ["id"],
            properties: {
                id: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
                order_id: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
                order_number: { oneOf: [{ type: "string" }, { type: "number" }], example: "ORDER_20001" },
                email: { type: "string", example: "risk.user@example.com" },
                phone: { type: "string", example: "+1 415-555-1234" },
                shipping_address: {
                    type: "object",
                    description: "Blacklist uses phone and address2 only here (not mobile, address1, city, etc.).",
                    properties: {
                        name: { type: "string", example: "Risk User" },
                        phone: { type: "string", example: "+1 415-555-1234" },
                        address2: { type: "string", example: "Apt 6" }
                    }
                },
                billing_address: {
                    type: "object",
                    description: "Blacklist uses phone and address2 only here (not mobile, address1, city, etc.).",
                    properties: {
                        name: { type: "string", example: "Risk User" },
                        phone: { type: "string", example: "+1 415-555-1234" },
                        address2: { type: "string", example: "Apt 6" }
                    }
                },
                note_attributes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string", example: "device_fingerprint" },
                            value: { type: "string", example: "fp_test_abc_001" }
                        }
                    }
                },
                device_fingerprint: { type: "string", example: "fp_test_abc_001" }
            }
        }
    }),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Headers)("x-shoplazza-hmac-sha256")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", Promise)
], WebhooksController.prototype, "handleOrderCreate", null);
exports.WebhooksController = WebhooksController = __decorate([
    (0, swagger_1.ApiTags)("webhooks"),
    (0, common_1.Controller)("webhooks/shoplazza/orders"),
    __metadata("design:paramtypes", [shoplazza_service_1.ShoplazzaService,
        webhooks_service_1.WebhooksService])
], WebhooksController);
//# sourceMappingURL=webhooks.controller.js.map