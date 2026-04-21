import { OrdersService } from "./orders.service";
export declare class OrdersController {
    private readonly ordersService;
    constructor(ordersService: OrdersService);
    save(body: Record<string, unknown>): Promise<{
        success: boolean;
        order_id: string;
        device_fingerprint_saved: boolean;
    }>;
}
