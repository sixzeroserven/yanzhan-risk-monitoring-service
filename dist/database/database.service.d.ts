import { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { EnvConfig } from "../common/config/env.config";
export declare class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly env;
    constructor(env: EnvConfig);
    onModuleInit(): Promise<void>;
    onModuleDestroy(): Promise<void>;
}
