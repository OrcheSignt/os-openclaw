import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Swagger for debugging
  const config = new DocumentBuilder()
    .setTitle('OrcheSight MCP Server')
    .setDescription('MCP server wrapping os-api-gateway for OpenClaw agents')
    .setVersion('1.0.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT || 3020;
  await app.listen(port);
  logger.log(`MCP server running on port ${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
  logger.log(`MCP endpoint at http://localhost:${port}/mcp`);
}

bootstrap();
