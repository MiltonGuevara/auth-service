import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/decorators/guards/jwt.guard.js';
import { OrganizationsService } from './organizations.service.js';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto/organization.dto.js';

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/v1/organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear una nueva organización y vincular al usuario' })
  @ApiResponse({ status: 201, description: 'Organización creada exitosamente.' })
  async create(
    @Req() req: { user: { sub: string } },
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizationsService.create(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar organizaciones del usuario autenticado' })
  @ApiResponse({ status: 200, description: 'Lista obtenida con éxito.' })
  async findAllByUser(@Req() req: { user: { sub: string } }) {
    return this.organizationsService.findAllByUser(req.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de una organización por ID' })
  async findOne(
    @Req() req: { user: { sub: string } },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.organizationsService.findOne(req.user.sub, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar una organización' })
  async update(
    @Req() req: { user: { sub: string } },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.update(req.user.sub, id, dto);
  }
}