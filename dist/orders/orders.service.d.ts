import { DatabaseService } from "../database/database.service";
export declare class OrdersService {
    private readonly db;
    constructor(db: DatabaseService);
    saveOrder(body: Record<string, unknown>): Promise<{
        success: boolean;
        order_id: string;
        device_fingerprint_saved: boolean;
    }>;
}
