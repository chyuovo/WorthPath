import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';
import {
  credentials,
  positionInput,
  positionMeta,
  revisionInput,
  transferInput,
  currency,
  hiddenMenus,
} from './validation';
export function setupOpenApi(app: INestApplication) {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('WorthPath API')
      .setVersion('1.1')
      .setDescription(
        '个人资产管理接口。金额使用十进制字符串；登录会话由 HttpOnly Cookie 传递，数据归属由服务端验证。',
      )
      .addCookieAuth('wp_session', { type: 'apiKey', in: 'cookie' }, 'session')
      .addSecurityRequirements('session')
      .build(),
  );
  const bodies: Record<string, z.ZodType> = {
    'POST /api/auth/register': credentials,
    'POST /api/auth/login': credentials,
    'POST /api/auth/reveal': credentials.pick({ password: true }),
    'POST /api/positions': positionInput,
    'PATCH /api/positions/{id}': positionMeta,
    'POST /api/positions/{id}/revisions': revisionInput,
    'PUT /api/positions/{id}/revisions/{revisionId}': revisionInput,
    'PUT /api/positions/{id}/links': z
      .object({ targetIds: z.array(z.string().uuid()).max(20) })
      .strict(),
    'POST /api/transfers': transferInput,
    'PATCH /api/settings': z
      .object({
        baseCurrency: currency.optional(),
        hiddenMenus: hiddenMenus.optional(),
        showNotes: z.boolean().optional(),
        idleMinutes: z.number().int().min(0).max(1440).optional(),
      })
      .strict(),
    'POST /api/backup/clear': z.object({ confirmation: z.literal('确定清空') }),
    'POST /api/backup/import-file': z.object({
      token: z.string().uuid(),
      confirmed: z.literal(true),
    }),
  };
  for (const [path, entry] of Object.entries(document.paths)) {
    for (const method of ['get', 'post', 'patch', 'put'] as const) {
      const operation = entry[method];
      if (!operation) continue;
      operation.summary = `${method.toUpperCase()} ${path}`;
      if (
        method === 'get' &&
        ['/api/history', '/api/positions/{id}/history', '/api/transfers'].includes(path)
      ) {
        operation.parameters = [
          ...(operation.parameters || []),
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string' },
            description: '上页 nextCursor；业务时间及唯一顺序键降序，写入或更正后重新读取第一页',
          },
          ...['from', 'to'].map((name) => ({
            name,
            in: 'query' as const,
            schema: { type: 'string', format: 'date' },
          })),
        ];
        operation.responses['200'] = {
          description: '{ items, nextCursor, revealed }；金额为绝对余额，before 为真实前序余额',
        };
      }
      if (method === 'get' && path === '/api/trend') {
        operation.parameters = [
          ...['from', 'to'].map((name) => ({
            name,
            in: 'query' as const,
            schema: { type: 'string', format: 'date' },
          })),
          {
            name: 'grain',
            in: 'query',
            schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' },
          },
        ];
        operation.description =
          '默认90天；日最多366天，周最多1096天，月最多3653天。取北京时间期末余额，归因累计每日变化；不返回每天项目明细。';
      }
      if (path === '/api/health' || ['/api/auth/register', '/api/auth/login'].includes(path))
        operation.security = [];
      const schema = bodies[method.toUpperCase() + ' ' + path];
      if (schema)
        operation.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: z.toJSONSchema(schema, { target: 'openapi-3.0' }) as any,
            },
          },
        };
      operation.responses['400'] = {
        description: '请求格式、金额或业务校验失败，返回 { message }',
      };
      operation.responses['401'] = { description: '未登录或会话失效' };
      operation.responses['403'] = { description: '请求来源或访问权限不受信任' };
      operation.responses['409'] = { description: '数据冲突或业务记录不可修改' };
      if (path === '/api/backup' && method === 'get')
        operation.responses['200'] = {
          description: '该用户全部数据的 ZIP 文件',
          content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
        };
      if (path === '/api/backup/upload' || path === '/api/icons/upload') {
        const properties = {
          file: { type: 'string', format: 'binary' },
          ...(path.includes('icons')
            ? {
                name: { type: 'string', description: '共享图标必须包含中文' },
                shared: { type: 'string', enum: ['false', 'true'], default: 'false' },
                confirmed: { type: 'string', enum: ['true'], description: '共享发布必须确认' },
              }
            : {}),
        };
        operation.requestBody = {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: path.includes('icons') ? ['file', 'name'] : ['file'],
                properties: properties as any,
              },
            },
          },
        };
      }
      if (['/api/backup/preview', '/api/backup/import'].includes(path))
        operation.requestBody = {
          required: true,
          description: '旧版 JSON 兼容入口；新版请使用 upload + import-file（支持完整 ZIP 备份）',
          content: {
            'application/json': { schema: { type: 'object', additionalProperties: true } },
          },
        };
    }
  }
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/openapi.json',
    swaggerOptions: { persistAuthorization: false, validatorUrl: null, withCredentials: true },
  });
}
