import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {

const config = new DocumentBuilder()
  .setTitle('Auth Service API')
  .setDescription('Microservicio de autenticación con JWT, PostgreSQL y Redis')
  .setVersion('1.0')
  .addBearerAuth() // Por si usaras tokens en el futuro
  .build();


  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes( new ValidationPipe());
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document); 
  
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
