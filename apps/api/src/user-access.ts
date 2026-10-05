import { z } from 'zod';
import { credentials } from './validation';

export const roles = z.enum(['admin', 'user', 'readonly']);
export const loginInput = credentials.extend({
  password: z
    .string()
    .min(1)
    .max(72)
    .refine((s) => Buffer.byteLength(s, 'utf8') <= 72, '密码最多 72 字节'),
});
export const adminDeleteInput = z
  .object({
    confirmationUsername: credentials.shape.username,
    currentPassword: loginInput.shape.password,
  })
  .strict();
export const adminCreateInput = credentials.extend({ role: roles.default('user') }).strict();
export const adminUpdateInput = z
  .object({ role: roles.optional(), banned: z.boolean().optional() })
  .strict()
  .refine((v) => v.role !== undefined || v.banned !== undefined, '请选择权限或封禁状态');
