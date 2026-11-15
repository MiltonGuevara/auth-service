import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import {Redis} from 'ioredis';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './atrategies/jwt.strategy.js';
import { User } from './entities/user.entity.js';
import { Organization } from './entities/organization.entity.js';
import { Role } from './entities/role.entity.js';
import { Permission } from './entities/permission.entity.js';
import { OrganizationMember } from './entities/organization-member.entity.js';
@Module({
  imports: [
    TypeOrmModule.forFeature([User, Organization, Role, Permission, OrganizationMember]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    
    // Configuración asíncrona de JWT usando la llave privada en Base64 desde el .env
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const privateKeyB64 = configService.get<string>('JWT_PRIVATE_KEY_B64');
        if (!privateKeyB64) {
          throw new Error('La variable JWT_PRIVATE_KEY_B64 no está definida en el archivo .env');
        }
        const privateKey = Buffer.from(privateKeyB64, 'base64').toString('utf8');

        // La llave pública se lee de forma segura del archivo físico
        const publicKey = fs.readFileSync(path.join(process.cwd(), 'keys', 'public.pem'));

        return {
          privateKey,
          publicKey,
          signOptions: {
            algorithm: 'RS256',
            expiresIn: '15m',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService], // 👈 Ya no lleva 'imports', solo inject y useFactory
      useFactory: (configService: ConfigService) => {
        const redis = new Redis({
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
        });

        // Manejo de errores de conexión para prevenir caídas fatales de la aplicación
        redis.on('error', (err) => {
          console.error('❌ Error de conexión en Redis:', err.message);
        });

        return redis;
      },
    },
  ],
  exports: [AuthService, JwtModule, 'REDIS_CLIENT'],
})
export class AuthModule {}