import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
const transactions = new AsyncLocalStorage<Prisma.TransactionClient>();
@Injectable()
export class Database extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super();
    return new Proxy(this, {
      get(target, key, receiver) {
        const tx = transactions.getStore();
        if (tx && key === '$transaction')
          return (work: any) => (typeof work === 'function' ? work(tx) : Promise.all(work));
        if (tx && key in tx && key !== '$disconnect' && key !== '$connect') {
          const value = (tx as any)[key];
          return typeof value === 'function' ? value.bind(tx) : value;
        }
        return Reflect.get(target, key, receiver);
      },
    });
  }
  async atomic<T>(work: () => Promise<T>, timeout = 30000): Promise<T> {
    return this.serial((tx) => transactions.run(tx, work), timeout);
  }
  async serial<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, timeout = 30000): Promise<T> {
    const current = transactions.getStore();
    if (current) return work(current);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout,
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
