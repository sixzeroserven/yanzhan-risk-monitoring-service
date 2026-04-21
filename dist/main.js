"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const swagger_1 = require("@nestjs/swagger");
const app_module_1 = require("./app.module");
const env_config_1 = require("./common/config/env.config");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { rawBody: true });
    const env = app.get(env_config_1.EnvConfig);
    app.useGlobalPipes(new common_1.ValidationPipe({ transform: true, whitelist: true }));
    const swaggerConfig = new swagger_1.DocumentBuilder()
        .setTitle("Shoplazza Blacklist Service")
        .setDescription("Shoplazza webhook interception and blacklist APIs")
        .setVersion("1.0.0")
        .build();
    const document = swagger_1.SwaggerModule.createDocument(app, swaggerConfig);
    swagger_1.SwaggerModule.setup("docs", app, document);
    await app.listen(env.port, "0.0.0.0");
    console.log(`\nService started successfully.`);
    console.log(`- Local API: http://localhost:${env.port}`);
    console.log(`- Health: http://localhost:${env.port}/health`);
    console.log(`- Swagger UI: http://localhost:${env.port}/docs`);
    console.log(`- Blacklist check: POST http://localhost:${env.port}/api/blacklist/check`);
    console.log(`- Save order: POST http://localhost:${env.port}/api/orders/save\n`);
}
bootstrap().catch((error) => {
    console.error("Failed to bootstrap application", error);
    process.exit(1);
});
//# sourceMappingURL=main.js.map