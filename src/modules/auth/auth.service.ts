import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Redis } from 'ioredis';
import { JwtPayload } from './atrategies/jwt.strategy.js';
import { RegisterDto, LoginDto } from './dto/auth.dto.js';
import { OrganizationMember } from './entities/organization-member.entity.js';
import { Organization } from './entities/organization.entity.js';
import { Role } from './entities/role.entity.js';
import { User } from './entities/user.entity.js';
import { BadRequestException } from '@nestjs/common';


interface StoredRefreshSession {
  userId: string;
  organizationId: string;
  used: boolean;
}

@Injectable()
export class AuthService {
  private readonly REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 días

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    @InjectRepository(OrganizationMember)
    private readonly memberRepo: Repository<OrganizationMember>,
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {}

  /**
   * Registro inicial: Crea el usuario, su primera organización y lo asigna como ADMIN por defecto.
   */
  async register(dto: RegisterDto) {
    const existingUser = await this.userRepo.findOne({ where: { email: dto.email } });
    if (existingUser) {
      throw new ConflictException('El correo electrónico ya está registrado');
    }

    const existingOrg = await this.orgRepo.findOne({ where: { taxId: dto.organizationTaxId } });
    if (existingOrg) {
      throw new ConflictException('El RTN / Identificación fiscal ya está registrado');
    }

    const adminRole = await this.roleRepo.findOne({ where: { name: 'ADMIN' } });
    if (!adminRole) {
      throw new Error('El rol ADMIN no existe en la base de datos. Ejecuta los seeds iniciales.');
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    
    // Generar token único para verificar el correo
    const verificationToken = crypto.randomBytes(32).toString('hex');

    // Transacción atómica para crear Usuario + Organización + Membresía
    const { savedUser, savedOrg } = await this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        isEmailVerified: false, // <-- Inicia en falso
        verificationToken,     // <-- Guardamos el token generado
      });
      const savedUser = await manager.save(user);

      const org = manager.create(Organization, {
        name: dto.organizationName,
        taxId: dto.organizationTaxId,
      });
      const savedOrg = await manager.save(org);

      const member = manager.create(OrganizationMember, {
        userId: savedUser.id,
        organizationId: savedOrg.id,
        roleId: adminRole.id,
        isDefault: true,
      });
      await manager.save(member);

      return { savedUser, savedOrg };
    });
    
    console.log(`[DEV] Token de verificación para ${dto.email}: ${verificationToken}`);

    return {
      message: 'Usuario registrado con éxito. Por favor verifica tu correo electrónico para activar completamente tu cuenta y organizaciones.',
      user: {
        id: savedUser.id,
        email: savedUser.email,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
      },
    };
  }


  /**
   * Valida el token de verificación de correo y activa la cuenta.
   */
  async verifyEmail(token: string) {
    const user = await this.userRepo.findOne({ where: { verificationToken: token } });
    
    if (!user) {
      throw new BadRequestException('El token de verificación es inválido o ya ha expirado.');
    }

    user.isEmailVerified = true;
    user.verificationToken = null as any; // Limpiamos el token para que sea de un solo uso
    await this.userRepo.save(user);

    return {
      message: 'Correo verificado exitosamente. Ya puedes iniciar sesión y operar tus organizaciones.',
    };
  }

  /**
   * Inicio de sesión: Valida contraseña con Argon2id y selecciona la organización por defecto.
   */
  async login(dto: LoginDto) {
    const user = await this.userRepo.findOne({ where: { email: dto.email } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Credenciales inválidas o cuenta inactiva');
    }

    // Validar si verificó su correo
    if (!user.isEmailVerified) {
      throw new ForbiddenException('Debes verificar tu correo electrónico antes de iniciar sesión.');
    }

    const isPasswordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // ... resto de tu lógica de login existente ...
  }
  /**
   * Cambio de organización activa: Emite un nuevo JWT con el nuevo org_id y permisos de esa empresa.
   */
  async switchOrganization(userId: string, targetOrgId: string) {
    return this.generateTokens(userId, targetOrgId);
  }

  /**
   * Rotación de Refresh Token con detección de reutilización maliciosa.
   */
  async refreshTokens(oldRefreshToken: string) {
    const redisKey = `refresh_token:${oldRefreshToken}`;
    const rawSession = await this.redis.get(redisKey);

    if (!rawSession) {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    const session: StoredRefreshSession = JSON.parse(rawSession);

    // Si el token ya había sido usado, posible robo de token -> invalidar sesiones del usuario
    if (session.used) {
      await this.revokeAllUserSessions(session.userId);
      throw new UnauthorizedException('Detección de reutilización de token. Todas las sesiones han sido cerradas.');
    }

    // Marcar el token actual como usado (mantenerlo brevemente para detectar replay attacks)
    session.used = true;
    await this.redis.set(redisKey, JSON.stringify(session), 'EX', 60);

    // Emitir nuevo par de tokens
    return this.generateTokens(session.userId, session.organizationId);
  }

  /**
   * Cierre de sesión: Elimina el Refresh Token de Redis.
   */
  async logout(refreshToken: string) {
    await this.redis.del(`refresh_token:${refreshToken}`);
    return { message: 'Sesión cerrada correctamente' };
  }

  /**
   * Genera el Access Token (RS256) y el Refresh Token rotativo en Redis.
   */
  async generateTokens(userId: string, organizationId: string) {
    const membership = await this.getUserMembershipWithPermissions(userId, organizationId);

    if (!membership || !membership.organization.isActive) {
      throw new ForbiddenException('No tienes acceso a esta organización o está inactiva');
    }

    const permissionCodes = membership.role.permissions.map((p) => p.code);

    const payload: JwtPayload = {
      sub: userId,
      org_id: organizationId,
      role: membership.role.name,
      permissions: permissionCodes,
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      algorithm: 'RS256',
      expiresIn: '15m',
    });

    const refreshToken = uuidv4();
    await this.saveRefreshTokenInRedis(refreshToken, userId, organizationId);

    return {
      accessToken,
      refreshToken,
      expiresIn: 900, // 15 minutos en segundos
    };
  }

  /**
   * Consulta membresía, rol y permisos del usuario para una organización específica.
   */private async getUserMembershipWithPermissions(
  userId: string,
  organizationId: string,
): Promise<OrganizationMember | null> {
  return this.memberRepo.findOne({
    where: { userId, organizationId },
    relations: ['organization', 'role', 'role.permissions'],
  } as any);
}

  /**
   * Guarda el Refresh Token en Redis y registra la clave en el índice de sesiones del usuario.
   */
  private async saveRefreshTokenInRedis(
    refreshToken: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const sessionData: StoredRefreshSession = {
      userId,
      organizationId,
      used: false,
    };

    const tokenKey = `refresh_token:${refreshToken}`;
    const userSessionsKey = `user_sessions:${userId}`;

    await this.redis.set(tokenKey, JSON.stringify(sessionData), 'EX', this.REFRESH_TTL_SECONDS);
    await this.redis.sadd(userSessionsKey, refreshToken);
    await this.redis.expire(userSessionsKey, this.REFRESH_TTL_SECONDS);
  }

  /**
   * Revoca todas las sesiones activas de un usuario en Redis.
   */
  private async revokeAllUserSessions(userId: string): Promise<void> {
    const userSessionsKey = `user_sessions:${userId}`;
    const tokens = await this.redis.smembers(userSessionsKey);

    if (tokens.length > 0) {
      const pipeline = this.redis.pipeline();
      tokens.forEach((token) => pipeline.del(`refresh_token:${token}`));
      pipeline.del(userSessionsKey);
      await pipeline.exec();
    }
  }

  /**
   * Convierte public.pem al formato estándar JWK (JSON Web Key) para servicios downstream.
   */
  getJwks() {
    const publicKeyPem = fs.readFileSync(path.join(process.cwd(), 'keys', 'public.pem'), 'utf8');
    const keyObject = crypto.createPublicKey(publicKeyPem);
    const jwk = keyObject.export({ format: 'jwk' });

    return {
      keys: [
        {
          ...jwk,
          alg: 'RS256',
          use: 'sig',
          kid: 'auth-service-key-1',
        },
      ],
    };
  }
}