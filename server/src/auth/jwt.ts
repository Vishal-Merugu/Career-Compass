import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface IJwtPayload {
  userId: string;
  email: string;
}

export function signToken(payload: IJwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): IJwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as IJwtPayload;
}
