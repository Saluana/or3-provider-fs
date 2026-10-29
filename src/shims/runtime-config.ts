export interface RuntimeConfigLike {
    security: { proxy: { trustProxy?: boolean }; allowedOrigins: string[] };
    auth: {
        enabled?: boolean;
        strict?: boolean;
        provider?: string;
        [key: string]: unknown;
    };
    storage: {
        enabled?: boolean;
        provider?: string;
        [key: string]: unknown;
    };
    public: {
        auth?: {
            enabled?: boolean;
            [key: string]: unknown;
        };
        storage: {
            enabled?: boolean;
            provider?: string;
            [key: string]: unknown;
        };
        sync: {
            provider?: string;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
    sync: {
        provider?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
