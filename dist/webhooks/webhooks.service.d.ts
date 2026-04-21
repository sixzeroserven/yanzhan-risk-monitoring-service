import { BlacklistService } from "../blacklist/blacklist.service";
import { ShoplazzaService } from "../shoplazza/shoplazza.service";
export declare class WebhooksService {
    private readonly blacklistService;
    private readonly shoplazzaService;
    constructor(blacklistService: BlacklistService, shoplazzaService: ShoplazzaService);
    processOrderCreate(order: Record<string, unknown>): Promise<{
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
