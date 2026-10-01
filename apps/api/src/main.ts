import 'reflect-metadata';
import 'dotenv/config';
import {Module,Controller,Get} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {PrismaClient} from '@prisma/client';
@Controller('api') class HealthController {@Get('health') health(){return {status:'ok',app:'WorthPath'};}}
@Module({controllers:[HealthController]}) class AppModule {}
async function bootstrap(){ const db=new PrismaClient();await db.$connect(); const app=await NestFactory.create(AppModule);await app.listen(Number(process.env.PORT||3000),'0.0.0.0');}void bootstrap();
