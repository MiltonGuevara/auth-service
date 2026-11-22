import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Allas Repuestos S.A.', description: 'Nombre comercial o razón social' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '05019012345678', description: 'RTN o identificación fiscal' })
  @IsString()
  @IsNotEmpty()
  taxId: string;
}

export class UpdateOrganizationDto {
  @ApiProperty({ example: 'Guevara Store', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ example: '05019012345678', required: false })
  @IsString()
  @IsOptional()
  taxId?: string;
}