import { EnvConfig } from "../common/config/env.config";
export declare class ShoplazzaService {
    private readonly env;
    constructor(env: EnvConfig);
    verifyWebhookSignature(rawBody: Buffer, providedHmac?: string): boolean;
    cancelOrder(orderId: string | number, reason?: string): Promise<void>;
    appendOrderNote(orderId: string | number, note: string): Promise<void>;
    private get client();
    private path;
}
