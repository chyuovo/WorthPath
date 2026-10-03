import 'reflect-metadata';
import 'dotenv/config';
import { setupOpenApi } from './openapi';
import { Module, Catch, ArgumentsHost, ExceptionFilter, HttpException } from '@nestjs/common';
import { NestFactory, APP_GUARD } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json } from 'express';
import { AuthController, AuthBusinessService, AuthGuard, AuthService } from './auth';
import { CalendarController, CalendarBusinessService } from './calendar';
import { SchedulesController, SchedulesBusinessService } from './schedules';
import { TransfersController, TransfersBusinessService } from './transfers';
import { PortfolioController, PortfolioBusinessService } from './portfolio';
import { BackupController, BackupBusinessService } from './backup';
import { IconsController, IconsBusinessService, IconsService } from './icons';
import { MetalsService, MetalsController, MetalsBusinessService } from './metals';
import { Database } from './database';
import { RatesService, SettingsController, SettingsBusinessService } from './rates';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AgentOAuth } from './mcp/oauth';
import { AgentCatalogue } from './mcp/catalogue';
import { AgentOperations } from './mcp/operations';
import { AgentFiles } from './mcp/files';
import { AgentTransport } from './mcp/transport';
import { AgentManagementController } from './mcp/management';
@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    let status = 500,
      message = '服务暂时不可用，请稍后重试';
    if (error instanceof ZodError) {
      status = 400;
      message = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；');
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      message = error.message;
    } else if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2002', 'P2034'].includes(error.code)
    ) {
      status = 409;
      message = '数据已存在或已被其他操作更新，请刷新后重试';
    } else if (error instanceof SyntaxError) {
      status = 400;
      message = 'JSON 文件或请求格式无效';
    } else if ((error as { status?: number })?.status === 413) {
      status = 413;
      message = '文件不能超过 8 MB';
    }
    host.switchToHttp().getResponse().setHeader('Cache-Control', 'no-store');
    host.switchToHttp().getResponse().status(status).json({ message });
  }
}
@Module({
  providers: [
    Database,
    AuthService,
    RatesService,
    MetalsService,
    IconsService,
    AuthBusinessService,
    CalendarBusinessService,
    SchedulesBusinessService,
    TransfersBusinessService,
    PortfolioBusinessService,
    BackupBusinessService,
    IconsBusinessService,
    MetalsBusinessService,
    SettingsBusinessService,
    AgentOAuth,
    AgentCatalogue,
    AgentOperations,
    AgentFiles,
    AgentTransport,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  controllers: [
    TransfersController,
    SchedulesController,
    CalendarController,
    IconsController,
    AuthController,
    PortfolioController,
    MetalsController,
    SettingsController,
    BackupController,
    AgentManagementController,
  ],
})
class AppModule {}
async function bootstrap() {
  if (!process.env.DATABASE_URL || !process.env.WEB_ORIGIN)
    throw Error('Missing local environment configuration');
  if (process.env.NODE_ENV === 'production' && process.env.WEB_ORIGIN === '*')
    throw Error('Production requires an explicit web origin');
  if (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'true')
    throw Error('Production requires secure cookies');
  const app = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
  app.use(helmet());
  app.use(json({ limit: '8mb' }));
  app.use(cookieParser());
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get(AgentTransport).install(app.getHttpAdapter().getInstance());
  app.useGlobalFilters(new SafeErrors());
  setupOpenApi(app);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT || 3100), '0.0.0.0');
  console.log('WorthPath API ready');
}
void bootstrap().catch(() => {
  console.error('API startup failed. Check local configuration and database availability.');
  process.exitCode = 1;
});
