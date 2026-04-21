import { BlacklistService } from "./blacklist.service";
export declare class BlacklistController {
    private readonly blacklistService;
    constructor(blacklistService: BlacklistService);
    check(body: Record<string, unknown>): Promise<{
        blocked: boolean;
        contact: {
            email: string;
            phoneNumber: string;
            detailAddress: string;
            address2: string;
            fingerprint: string;
        };
        hits: import("./blacklist.service").BlacklistHit[];
    }>;
}
