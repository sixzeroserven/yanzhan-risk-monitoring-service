import { DatabaseService } from "../database/database.service";
export interface BlacklistHit {
    id: number;
    order_id: string;
    package_number: string;
    hit_type: string;
    hit_value: string;
}
export declare class BlacklistService {
    private readonly db;
    constructor(db: DatabaseService);
    checkByInput(input: Record<string, unknown>): Promise<{
        blocked: boolean;
        contact: {
            email: string;
            phoneNumber: string;
            detailAddress: string;
            address2: string;
            fingerprint: string;
        };
        hits: BlacklistHit[];
    }>;
    checkByOrder(order: Record<string, unknown>): Promise<{
        blocked: boolean;
        contact: {
            email: string;
            phoneNumber: string;
            detailAddress: string;
            address2: string;
            fingerprint: string;
        };
        hits: BlacklistHit[];
    }>;
    markOrderAsBlacklisted(order: Record<string, unknown>): Promise<void>;
    private checkByContact;
    private getBlacklistedOrders;
    private findByEmail;
    private findByPhoneNumber;
    private findByDetailAddress;
    private findByAddress2;
    private findByFingerprint;
}
