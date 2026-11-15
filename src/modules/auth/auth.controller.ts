import { Controller, Post, Body, Get, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/decorators/guards/jwt.guard.js';
import { AuthService } from './auth.service.js';
import { RegisterDto, LoginDto, RefreshTokenDto, SwitchOrganizationDto } from './dto/auth.dto.js';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshTokens(dto.refreshToken);
  }

@UseGuards(JwtAuthGuard)
@HttpCode(HttpStatus.OK)
@Post('switch-organization')
async switchOrganization(@Req() req: { user: { sub: string } }, @Body() dto: SwitchOrganizationDto) {
  return this.authService.switchOrganization(req.user.sub, dto.organizationId);
}

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  @Get('.well-known/jwks.json')
  getJwks() {
    return this.authService.getJwks();
  }
}