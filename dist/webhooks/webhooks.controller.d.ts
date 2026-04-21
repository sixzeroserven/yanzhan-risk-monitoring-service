import { Request } from "express";
import { ShoplazzaService } from "../shoplazza/shoplazza.service";
import { WebhooksService } from "./webhooks.service";
export declare class WebhooksController {
    private readonly shoplazzaService;
    private readonly webhooksService;
    constructor(shoplazzaService: ShoplazzaService, webhooksService: WebhooksService);
    handleOrderCreate(req: Request & {
        rawBody?: Buffer;
    }, body: Record<string, unknown>, hmac?: string): Promise<{
        blocked: boolean;
        orderId: string | number;
        hitCount?: undefined;
        hitTypes?: undefined;
    } | {
        blocked: boolean;
        orderId: string | number;
        hitCount: number;
        hitTypes: string[];
    }>;
}
