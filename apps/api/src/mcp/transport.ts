import { networkConfig, isNetworkOriginAllowed } from '../network';
import { Injectable } from '@nestjs/common';
import { Express } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { AgentOAuth, urls, scopes } from './oauth';
import { AgentOperations, writing, plain } from './operations';
import { AgentFiles } from './files';
import { Database } from '../database';
import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { isAllowedMcpHost } from './hosts';

export function toolResult(value: unknown) {
  const data = plain(value);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          summary: data?.status ? `操作状态：${data.status}` : '查询或操作已完成',
          data,
        }),
      },
    ],
    structuredContent: { data },
  };
}
@Injectable()
export class AgentTransport {
  constructor(
    private oauth: AgentOAuth,
    private operations: AgentOperations,
    private files: AgentFiles,
    private db: Database,
  ) {}
  install(app: Express) {
    const { issuer, resource } = urls();
    // The SDK reads this flag when its router module is first loaded.
    process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL =
      networkConfig().allowHttp && issuer.protocol === 'http:' ? 'true' : 'false';
    const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } =
      require('@modelcontextprotocol/sdk/server/auth/router.js') as typeof import('@modelcontextprotocol/sdk/server/auth/router.js');
    const network = networkConfig();
    const rateLimit = network.rateLimitEnabled
      ? { windowMs: network.rateLimitWindowMs, limit: network.mcpAuthRateLimitMax }
      : (false as const);
    app.use(
      mcpAuthRouter({
        provider: this.oauth,
        issuerUrl: issuer,
        resourceServerUrl: resource,
        scopesSupported: [...scopes],
        resourceName: 'WorthPath',
        authorizationOptions: { rateLimit },
        tokenOptions: { rateLimit },
        revocationOptions: { rateLimit },
        clientRegistrationOptions: { rateLimit },
      }),
    );
    this.files.install(app);
    app.all(
      '/mcp',
      (req, res, next) => {
        const allowed = process.env.MCP_ALLOWED_ORIGINS || urls().web.origin;
        if (
          req.headers.origin &&
          !isNetworkOriginAllowed(req.headers.origin, allowed, networkConfig().allowWildcardOrigins)
        ) {
          res.status(403).json({ error: 'Untrusted origin' });
          return;
        }
        if (
          !isAllowedMcpHost(
            req.headers.host,
            resource,
            process.env.MCP_ALLOWED_HOSTS,
            !networkConfig().allowLoopbackHosts,
          )
        ) {
          res.status(403).json({ error: 'Untrusted host' });
          return;
        }
        if (req.method === 'OPTIONS') {
          if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
          res.setHeader(
            'Access-Control-Allow-Headers',
            'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id',
          );
          res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
          res.status(204).end();
          return;
        }
        if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        next();
      },
      requireBearerAuth({
        verifier: this.oauth,
        requiredScopes: ['read'],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
      }),
      async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('Allow', 'POST');
          res.status(405).end();
          return;
        }
        const grantId = String(req.auth?.extra?.grantId);
        const invoke = async (name: string, work: () => Promise<unknown>) => {
          let status = 'success';
          try {
            return toolResult(await work());
          } catch (e) {
            status = 'error';
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    e instanceof HttpException || e instanceof ZodError
                      ? e.message
                      : '操作失败，未提交账目变更；请检查参数或稍后重试',
                },
              ],
            };
          } finally {
            const grant = await this.oauth.grant(grantId).catch(() => null);
            if (grant)
              await this.db.agentCall
                .create({ data: { userId: grant.userId, grantId, tool: name, status } })
                .catch(() => {});
          }
        };
        const server = new McpServer(
          { name: 'WorthPath', version: '1.0.0' },
          {
            instructions:
              '金额为十进制字符串；业务日期 UTC+8，时间戳 ISO UTC。先 state_get 再写入，所有写入要求幂等键。pending 返回网页入口，用户确认后用 operation_get 查询。只使用稳定 UUID；重名询问用户。',
          },
        );
        for (const tool of this.operations.tools) {
          server.registerTool(
            tool.name,
            {
              description: tool.description,
              inputSchema: tool.scope === 'read' ? tool.schema : tool.schema.safeExtend(writing),
              annotations: {
                readOnlyHint: tool.scope === 'read',
                destructiveHint: !!tool.destructive,
                idempotentHint: tool.scope !== 'read',
                openWorldHint: ['rates_refresh', 'metals_refresh'].includes(tool.name),
              },
            },
            async (p: any) => {
              return invoke(tool.name, () => this.operations.call(grantId, tool.name, p));
            },
          );
        }
        const register = (
          name: string,
          description: string,
          schema: z.ZodObject<any>,
          run: (p: any) => Promise<unknown>,
          read = true,
        ) =>
          server.registerTool(
            name,
            {
              description,
              inputSchema: schema,
              annotations: {
                readOnlyHint: read,
                destructiveHint: false,
                idempotentHint: read,
                openWorldHint: false,
              },
            },
            async (p: any) => invoke(name, () => run(p)),
          );
        register(
          'state_get',
          '获取当前用户账目并发版本 state，写入时作为 expectedState。',
          z.object({}).strict(),
          async () => ({
            state: await this.db.$transaction(async () =>
              this.operations.state((await this.oauth.grant(grantId)).userId),
            ),
          }),
        );
        register(
          'operation_get',
          '查询此连接发起的操作状态、过期时间和最终结果。',
          z.object({ operationId: z.string().uuid() }).strict(),
          (p) => this.operations.status(grantId, p.operationId),
        );
        register(
          'file_upload_request',
          '创建受 Bearer 保护的短期文件上传入口；multipart/form-data 的 file 字段。',
          z.object({ kind: z.enum(['icon']) }).strict(),
          (p) => this.operations.uploadRequest(grantId, p.kind),
          false,
        );
        register(
          'file_status',
          '查看此连接私有图标上传状态，不返回令牌。',
          z.object({ fileId: z.string().uuid() }).strict(),
          (p) => this.operations.fileStatus(grantId, p.fileId),
        );
        register(
          'icon_image',
          '取得受 Bearer 保护的短期 PNG 图标读取入口。',
          z.object({ id: z.string().uuid() }).strict(),
          (p) => this.operations.iconImage(grantId, p.id),
        );
        register(
          'connection_info',
          '查询本连接权限、到期时间、资源及隐藏账户权限；不返回任何令牌。',
          z.object({}).strict(),
          async () => {
            const g = await this.oauth.grant(grantId);
            return {
              name: g.name,
              scopes: g.scopes,
              expiresAt: g.expiresAt,
              authorizationExpiresAt: g.clientId ? g.refreshExpiresAt : g.expiresAt,
              resource: g.resource,
              permission: (g.scopes as string[]).includes('write')
                ? 'write'
                : (g.scopes as string[]).includes('draft')
                  ? 'draft'
                  : 'read',
              readHidden: (g.scopes as string[]).includes('hidden_read'),
              writeHidden: (g.scopes as string[]).includes('hidden_write'),
            };
          },
        );
        register(
          'connection_revoke',
          '立即撤销本 Agent 连接并退出授权；不影响网页登录。撤销后无法继续查询，请先保存操作结果。',
          z.object({}).strict(),
          async () => {
            const g = await this.oauth.grant(grantId);
            await this.db.agentGrant.update({
              where: { id: g.id },
              data: { revokedAt: new Date() },
            });
            return { revoked: true };
          },
          false,
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.once('close', () => {
          void transport.close();
          void server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch {
          if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
        }
      },
    );
  }
}
