import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './modules/auth/auth.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';

@Module({
  imports: [
    // 1. Configuración global del archivo .env
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // 2. Conexión dinámica a PostgreSQL usando variables de entorno
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule, OrganizationsModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USER'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_NAME', 'auth_db'),
        autoLoadEntities: true,
        synchronize: false, // En producción debe ir en false (usa migraciones)
      }),
    }),

    // 3. Módulo de Autenticación que creamos antes
    AuthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}