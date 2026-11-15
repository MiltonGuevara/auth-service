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

    // Transacción atómica para crear Usuario + Organización + Membresía
    const { savedUser, savedOrg } = await this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
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

    const tokens = await this.generateTokens(savedUser.id, savedOrg.id);
    return {
      user: {
        id: savedUser.id,
        email: savedUser.email,
        firstName: savedUser.firstName,
        lastName: savedUser.lastName,
      },
      activeOrganization: {
        id: savedOrg.id,
        name: savedOrg.name,
      },
      ...tokens,
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

    const isPasswordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Obtener todas las organizaciones del usuario
    const memberships = await this.memberRepo.find({
      where: { userId: user.id },
    });

    if (memberships.length === 0) {
      throw new ForbiddenException('El usuario no pertenece a ninguna organización activa');
    }

    // Seleccionar la organización marcada como isDefault, o la primera disponible
    const defaultMembership = memberships.find((m) => m.isDefault) || memberships[0];

    const tokens = await this.generateTokens(user.id, defaultMembership.organizationId);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      activeOrganization: {
        id: defaultMembership.organization.id,
        name: defaultMembership.organization.name,
        role: defaultMembership.role.name,
      },
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        role: m.role.name,
        isDefault: m.isDefault,
      })),
      ...tokens,
    };
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