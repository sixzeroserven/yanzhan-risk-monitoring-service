export declare function safeString(value: unknown): string;
export declare function normalizeEmail(value: unknown): string;
export declare function normalizePhone(value: unknown): string;
export declare function normalizeAddress(value: unknown): string;
export declare function joinAddressParts(address?: Record<string, unknown>): string;
export declare function joinBlacklistAddressParts(address?: Record<string, unknown>): string;
export declare function getDeviceFingerprint(order?: Record<string, unknown>): string;
