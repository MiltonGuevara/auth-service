import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as fs from 'fs';
import * as path from 'path';

export interface JwtPayload {
  sub: string;
  org_id: string;
  role: string;
  permissions: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: fs.readFileSync(path.join(process.cwd(), 'keys', 'public.pem')),
      algorithms: ['RS256'],
    });
  }

  async validate(payload: JwtPayload) {
    return payload; // Se inyecta en req.user
  }
}