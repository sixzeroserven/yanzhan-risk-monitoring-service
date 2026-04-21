export declare class EnvConfig {
    constructor();
    get port(): number;
    get db(): {
        host: string;
        port: number;
        user: string;
        password: string;
        database: string;
        connectionLimit: number;
    };
    get databaseUrl(): string;
    get shoplazza(): {
        storeDomain: string;
        adminToken: string;
        webhookSecret: string;
        timeoutMs: number;
        cancelOrderPathTemplate: string;
        updateOrderPathTemplate: string;
    };
}
