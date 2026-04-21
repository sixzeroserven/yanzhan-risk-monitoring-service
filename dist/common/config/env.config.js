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
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnvConfig = void 0;
const common_1 = require("@nestjs/common");
const dotenv = __importStar(require("dotenv"));
dotenv.config();
let EnvConfig = class EnvConfig {
    constructor() {
        const required = [
            "PORT",
            "DB_HOST",
            "DB_PORT",
            "DB_USER",
            "DB_PASSWORD",
            "DB_NAME",
            "SHOPLAZZA_STORE_DOMAIN",
            "SHOPLAZZA_ADMIN_TOKEN",
            "SHOPLAZZA_WEBHOOK_SECRET"
        ];
        for (const key of required) {
            if (!process.env[key])
                throw new Error(`Missing required environment variable: ${key}`);
        }
    }
    get port() {
        return Number(process.env.PORT);
    }
    get db() {
        return {
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10)
        };
    }
    get databaseUrl() {
        const user = encodeURIComponent(process.env.DB_USER);
        const password = encodeURIComponent(process.env.DB_PASSWORD);
        const host = process.env.DB_HOST;
        const port = Number(process.env.DB_PORT);
        const database = process.env.DB_NAME;
        return `mysql://${user}:${password}@${host}:${port}/${database}`;
    }
    get shoplazza() {
        return {
            storeDomain: process.env.SHOPLAZZA_STORE_DOMAIN,
            adminToken: process.env.SHOPLAZZA_ADMIN_TOKEN,
            webhookSecret: process.env.SHOPLAZZA_WEBHOOK_SECRET,
            timeoutMs: Number(process.env.SHOPLAZZA_TIMEOUT_MS || 10000),
            cancelOrderPathTemplate: process.env.SHOPLAZZA_CANCEL_ORDER_PATH_TEMPLATE ||
                "/admin/openapi/2020-07/orders/{orderId}/cancel.json",
            updateOrderPathTemplate: process.env.SHOPLAZZA_UPDATE_ORDER_PATH_TEMPLATE ||
                "/admin/openapi/2020-07/orders/{orderId}.json"
        };
    }
};
exports.EnvConfig = EnvConfig;
exports.EnvConfig = EnvConfig = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], EnvConfig);
//# sourceMappingURL=env.config.js.map