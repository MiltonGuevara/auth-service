import { Controller, Post, Body, Get, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/decorators/guards/jwt.guard.js';
import { AuthService } from './auth.service.js';
import { RegisterDto, LoginDto, RefreshTokenDto, SwitchOrganizationDto } from './dto/auth.dto.js';

@ApiTags('Auth') // Agrupa todos estos endpoints bajo la categoría "Auth" en Swagger
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Registrar un nuevo usuario' })
  @ApiResponse({ status: 201, description: 'Usuario registrado exitosamente.' })
  @ApiResponse({ status: 400, description: 'Datos inválidos o usuario ya existe.' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiOperation({ summary: 'Iniciar sesión y obtener tokens' })
  @ApiResponse({ status: 200, description: 'Login exitoso.' })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas.' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  @ApiOperation({ summary: 'Renovar el token de acceso usando el refresh token' })
  @ApiResponse({ status: 200, description: 'Tokens renovados con éxito.' })
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshTokens(dto.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth() // Indica en Swagger que este endpoint requiere token Bearer
  @HttpCode(HttpStatus.OK)
  @Post('switch-organization')
  @ApiOperation({ summary: 'Cambiar la organización activa del usuario' })
  @ApiResponse({ status: 200, description: 'Organización cambiada con éxito.' })
  async switchOrganization(@Req() req: { user: { sub: string } }, @Body() dto: SwitchOrganizationDto) {
    return this.authService.switchOrganization(req.user.sub, dto.organizationId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  @ApiOperation({ summary: 'Cerrar sesión e invalidar refresh token' })
  @ApiResponse({ status: 200, description: 'Sesión cerrada correctamente.' })
  async logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('.well-known/jwks.json')
  @ApiOperation({ summary: 'Obtener las JSON Web Key Sets (JWKS) públicas para validar tokens' })
  getJwks() {
    return this.authService.getJwks();
  }
}