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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShoplazzaService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = __importDefault(require("axios"));
const crypto = __importStar(require("crypto"));
const env_config_1 = require("../common/config/env.config");
let ShoplazzaService = class ShoplazzaService {
    constructor(env) {
        this.env = env;
    }
    verifyWebhookSignature(rawBody, providedHmac) {
        if (!providedHmac || !rawBody)
            return false;
        const digest = crypto
            .createHmac("sha256", this.env.shoplazza.webhookSecret)
            .update(rawBody)
            .digest("base64");
        const received = Buffer.from(providedHmac, "utf8");
        const expected = Buffer.from(digest, "utf8");
        if (received.length !== expected.length)
            return false;
        return crypto.timingSafeEqual(received, expected);
    }
    async cancelOrder(orderId, reason = "fraud") {
        await this.client.post(this.path(this.env.shoplazza.cancelOrderPathTemplate, orderId), { reason });
    }
    async appendOrderNote(orderId, note) {
        await this.client.put(this.path(this.env.shoplazza.updateOrderPathTemplate, orderId), {
            order: { id: orderId, note }
        });
    }
    get client() {
        return axios_1.default.create({
            baseURL: `https://${this.env.shoplazza.storeDomain}`,
            timeout: this.env.shoplazza.timeoutMs,
            headers: {
                "Content-Type": "application/json",
                "X-Shoplazza-Access-Token": this.env.shoplazza.adminToken
            }
        });
    }
    path(template, orderId) {
        return template.replace("{orderId}", encodeURIComponent(String(orderId)));
    }
};
exports.ShoplazzaService = ShoplazzaService;
exports.ShoplazzaService = ShoplazzaService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [env_config_1.EnvConfig])
], ShoplazzaService);
//# sourceMappingURL=shoplazza.service.js.map