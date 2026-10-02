import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
@Injectable()
export class Database extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async serial<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        // Serializable deadlock/write conflict; retry the entire atomic operation.
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' ||
            (error.code === 'P2010' && ['1213', '1205'].includes(String(error.meta?.code))));
        if (!retryable || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt + Math.random() * 20));
      }
    }
  }
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
