import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

// Provision test data directly; production registration remains disabled.
export async function provisionTestUser(input: { username: string; password: string }) {
  const db = new PrismaClient();
  try {
    return await db.user.create({
      data: { username: input.username, passwordHash: await hash(input.password, 12) },
    });
  } finally {
    await db.$disconnect();
  }
}
