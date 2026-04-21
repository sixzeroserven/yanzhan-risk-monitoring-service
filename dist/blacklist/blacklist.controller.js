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
exports.BlacklistController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const blacklist_service_1 = require("./blacklist.service");
let BlacklistController = class BlacklistController {
    constructor(blacklistService) {
        this.blacklistService = blacklistService;
    }
    async check(body) {
        return this.blacklistService.checkByInput(body || {});
    }
};
exports.BlacklistController = BlacklistController;
__decorate([
    (0, common_1.Post)("check"),
    (0, swagger_1.ApiOperation)({ summary: "Check whether input is blacklisted" }),
    (0, swagger_1.ApiBody)({
        schema: {
            type: "object",
            description: "Blacklist check uses email, phone_number, detail_address, address2, device_fingerprint. detail_address and address2 are matched independently (OR).",
            properties: {
                email: { type: "string", example: "risk.user@example.com" },
                phone_number: { type: "string", example: "14155551234" },
                detail_address: { type: "string", example: "123 Main Street" },
                address2: { type: "string", example: "Apt 6" },
                device_fingerprint: { type: "string", example: "fp_test_abc_001" },
                fingerprint: { type: "string", example: "fp_test_abc_001" },
                deviceFingerprint: { type: "string", example: "fp_test_abc_001" }
            }
        }
    }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], BlacklistController.prototype, "check", null);
exports.BlacklistController = BlacklistController = __decorate([
    (0, swagger_1.ApiTags)("blacklist"),
    (0, common_1.Controller)("api/blacklist"),
    __metadata("design:paramtypes", [blacklist_service_1.BlacklistService])
], BlacklistController);
//# sourceMappingURL=blacklist.controller.js.map