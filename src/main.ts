import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { EnvConfig } from "./common/config/env.config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const env = app.get(EnvConfig);

  app.enableCors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Order-Remark-Token"],
    credentials: false
  });

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Shoplazza Blacklist Service")
    .setDescription("Shoplazza webhook interception and blacklist APIs")
    .setVersion("1.0.0")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, document);

  await app.listen(env.port, "0.0.0.0");

  console.log(`\nService started successfully.`);
  // console.log(`- Local API: http://localhost:${env.port}`);
  // console.log(`- Health: http://localhost:${env.port}/health`);
  console.log(`- Swagger UI: http://localhost:${env.port}/docs`);
  // console.log(`- Blacklist check: POST http://localhost:${env.port}/api/blacklist/check`);
  // console.log(`- Save order: POST http://localhost:${env.port}/api/orders/save\n`);
}

bootstrap().catch((error) => {
  console.error("应用启动失败", error);
  process.exit(1);
});
