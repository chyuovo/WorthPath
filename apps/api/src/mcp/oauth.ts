import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Response } from 'express';
import { z } from 'zod';
import { Database } from '../database';
import {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const scopes = ['read', 'draft', 'write', 'hidden_read', 'hidden_write'] as const;
export const scopeInput = z
  .array(z.enum(scopes))
  .min(1)
  .max(4)
  .refine(
    (v) =>
      v.includes('read') &&
      new Set(v).size === v.length &&
      !(v.includes('draft') && v.includes('write')) &&
      (!v.includes('hidden_write') ||
        (v.includes('hidden_read') && (v.includes('draft') || v.includes('write')))),
  );
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export function urls() {
  const resource = new URL(process.env.MCP_PUBLIC_URL || 'http://localhost:3100/mcp');
  if (
    resource.pathname !== '/mcp' ||
    resource.search ||
    resource.hash ||
    resource.username ||
    resource.password
  )
    throw Error('MCP_PUBLIC_URL must be the canonical /mcp URL');
  if (
    resource.protocol !== 'https:' &&
    !(
      process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(resource.hostname)
    )
  )
    throw Error('MCP requires HTTPS except local development');
  const web = new URL(process.env.MCP_WEB_URL || 'http://localhost:5173');
  if (
    web.protocol !== 'https:' &&
    !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(web.hostname))
  )
    throw Error('MCP web confirmation requires HTTPS');
  return { resource, issuer: new URL(resource.origin), web };
}
export function webLink(key: string, id: string) {
  const u = new URL(urls().web);
  u.searchParams.set(key, id);
  return u.toString();
}

@Injectable()
export class AgentOAuth implements OAuthServerProvider {
  constructor(private db: Database) {}
  get clientsStore() {
    return {
      getClient: async (id: string) => {
        const row = await this.db.agentClient.findUnique({ where: { id } });
        return row?.metadata as OAuthClientInformationFull | undefined;
      },
      registerClient: async (
        input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
      ) => {
        if (input.token_endpoint_auth_method !== 'none')
          throw new InvalidClientMetadataError('Only public PKCE clients are supported');
        if (!input.redirect_uris.length || input.redirect_uris.length > 10)
          throw new InvalidClientMetadataError('Invalid redirect URIs');
        for (const value of input.redirect_uris) {
          const u = new URL(value);
          if (
            u.hash ||
            u.username ||
            u.password ||
            !(
              u.protocol === 'https:' ||
              (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
            )
          )
            throw new InvalidClientMetadataError('HTTPS or loopback redirect required');
        }
        if ((await this.db.agentClient.count()) >= 10000)
          throw new InvalidClientMetadataError('Client registration limit reached');
        const client = {
          ...input,
          client_name: z
            .string()
            .min(1)
            .max(100)
            .parse(input.client_name || 'MCP client'),
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        await this.db.agentClient.create({
          data: { id: client.client_id, metadata: JSON.parse(JSON.stringify(client)) },
        });
        return client;
      },
    };
  }
  private resource(resource?: URL) {
    if (resource?.toString() !== urls().resource.toString())
      throw new InvalidTargetError('WorthPath resource is required');
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.resource(params.resource);
    const selected = params.scopes?.length ? params.scopes : ['read'];
    if (
      !z
        .array(z.enum(scopes))
        .min(1)
        .max(scopes.length)
        .refine((v) => v.includes('read') && new Set(v).size === v.length)
        .safeParse(selected).success
    )
      throw new InvalidScopeError('Unsupported scope');
    const row = await this.db.agentAuthorization.create({
      data: {
        clientId: client.client_id,
        parameters: JSON.parse(
          JSON.stringify({ ...params, resource: params.resource!.toString(), scopes: selected }),
        ),
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    res.redirect(webLink('agent_authorization', row.id));
  }
  async pending(id: string) {
    const row = await this.db.agentAuthorization.findUnique({ where: { id } });
    if (!row || row.status !== 'pending' || row.expiresAt <= new Date())
      throw new BadRequestException('授权请求已失效');
    const client = await this.clientsStore.getClient(row.clientId);
    const p = row.parameters as any;
    return {
      id,
      name: client?.client_name,
      redirectUri: p.redirectUri,
      scopes: p.scopes,
      resource: p.resource,
    };
  }
  async consent(userId: string, id: string, approved: boolean, selected?: string[]) {
    return this.db.atomic(async () => {
      await this.pending(id);
      const row = await this.db.agentAuthorization.findUniqueOrThrow({ where: { id } });
      const parameters = row.parameters as any;
      const allowed = selected || ['read'];
      scopeInput.parse(allowed);
      if (allowed.some((scope: string) => !parameters.scopes.includes(scope)))
        throw new BadRequestException('不能授予客户端未请求的权限');
      const code = secret();
      const changed = await this.db.agentAuthorization.updateMany({
        where: { id, status: 'pending', expiresAt: { gt: new Date() } },
        data: {
          userId,
          status: approved ? 'approved' : 'denied',
          codeDigest: approved ? digest(code) : null,
          parameters: { ...parameters, scopes: allowed },
        },
      });
      if (!changed.count) throw new BadRequestException('授权请求已处理');
      const p = row.parameters as any,
        callback = new URL(p.redirectUri);
      callback.searchParams.set(approved ? 'code' : 'error', approved ? code : 'access_denied');
      if (p.state) callback.searchParams.set('state', p.state);
      return { redirect: callback.toString() };
    });
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const row = await this.db.agentAuthorization.findUnique({
      where: { codeDigest: digest(code) },
    });
    if (
      !row ||
      row.clientId !== client.client_id ||
      row.status !== 'approved' ||
      row.expiresAt <= new Date()
    )
      throw new InvalidGrantError('Invalid authorization code');
    return (row.parameters as any).codeChallenge as string;
  }
  async issue(
    userId: string,
    name: string,
    selected: string[],
    days: number | null,
    clientId?: string,
  ) {
    if (clientId && days === null) throw new BadRequestException('OAuth 连接必须有期限');
    const access = secret(),
      refresh = clientId ? secret() : undefined,
      sessionId = digest(secret());
    const expiresAt = days === null ? null : new Date(Date.now() + days * 86400000),
      refreshExpiresAt = clientId ? new Date(Date.now() + 30 * 86400000) : null;
    await this.db.session.create({
      data: {
        id: sessionId,
        userId,
        expiresAt: refreshExpiresAt || expiresAt || new Date(Date.now() + 86400000),
      },
    });
    const grant = await this.db.agentGrant.create({
      data: {
        userId,
        name,
        clientId,
        scopes: selected,
        resource: urls().resource.toString(),
        accessDigest: digest(access),
        refreshDigest: refresh ? digest(refresh) : null,
        expiresAt,
        refreshExpiresAt,
        sessionId,
      },
    });
    return {
      grant,
      tokens: {
        access_token: access,
        token_type: 'Bearer',
        ...(days === null ? {} : { expires_in: Math.floor(days * 86400) }),
        scope: selected.join(' '),
        ...(refresh ? { refresh_token: refresh } : {}),
      } as OAuthTokens,
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.resource(resource);
    return this.db.atomic(async () => {
      await this.challengeForAuthorizationCode(client, code);
      const row = await this.db.agentAuthorization.findUniqueOrThrow({
          where: { codeDigest: digest(code) },
        }),
        p = row.parameters as any;
      // SDK tokenHandler validates S256 PKCE before invoking this provider, and passes
      // undefined for verifier after successful local validation (skipLocalPkceValidation=false).
      if (
        redirectUri !== p.redirectUri ||
        (verifier && createHash('sha256').update(verifier).digest('base64url') !== p.codeChallenge)
      )
        throw new InvalidGrantError('PKCE or redirect mismatch');
      const changed = await this.db.agentAuthorization.updateMany({
        where: { id: row.id, status: 'approved' },
        data: { status: 'used', codeDigest: null },
      });
      if (!changed.count) throw new InvalidGrantError('Code already used');
      return (
        await this.issue(
          row.userId!,
          client.client_name || 'MCP client',
          p.scopes,
          1 / 24,
          client.client_id,
        )
      ).tokens;
    });
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    selected?: string[],
    resource?: URL,
  ) {
    this.resource(resource);
    return this.db.atomic(async () => {
      const row = await this.db.agentGrant.findUnique({ where: { refreshDigest: digest(token) } });
      if (
        !row ||
        row.clientId !== client.client_id ||
        row.revokedAt ||
        !row.refreshExpiresAt ||
        row.refreshExpiresAt <= new Date()
      )
        throw new InvalidGrantError('Invalid refresh token');
      const current = row.scopes as string[];
      if (
        selected &&
        (!scopeInput.safeParse(selected).success || selected.some((s) => !current.includes(s)))
      )
        throw new InvalidScopeError('Scope escalation rejected');
      const access = secret(),
        refresh = secret();
      const changed = await this.db.agentGrant.updateMany({
        where: { id: row.id, refreshDigest: digest(token), revokedAt: null },
        data: {
          accessDigest: digest(access),
          refreshDigest: digest(refresh),
          expiresAt: new Date(Date.now() + 3600000),
          scopes: selected || current,
        },
      });
      if (!changed.count) throw new InvalidGrantError('Refresh token already used');
      return {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: (selected || current).join(' '),
      };
    });
  }
  async verifyAccessToken(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new InvalidTokenError('Invalid token');
    const row = await this.db.agentGrant.findUnique({ where: { accessDigest: digest(token) } });
    if (
      !row ||
      row.revokedAt ||
      (row.expiresAt ? row.expiresAt <= new Date() : !!row.clientId) ||
      row.resource !== urls().resource.toString()
    )
      throw new InvalidTokenError('Expired, revoked or invalid resource token');
    return {
      token,
      clientId: row.clientId || row.id,
      scopes: row.scopes as string[],
      // SDK bearer middleware requires a finite verified-authentication expiry.
      // A permanent PAT stays expiry-free in storage; every request rechecks revocation.
      expiresAt: Math.floor((row.expiresAt?.getTime() ?? Date.now() + 3600000) / 1000),
      resource: new URL(row.resource),
      extra: { grantId: row.id, userId: row.userId },
    };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    await this.db.agentGrant.updateMany({
      where: {
        clientId: client.client_id,
        OR: [{ accessDigest: digest(request.token) }, { refreshDigest: digest(request.token) }],
      },
      data: { revokedAt: new Date() },
    });
  }
  async grant(id: string, userId?: string) {
    const row = await this.db.agentGrant.findFirst({
      where: {
        id,
        ...(userId ? { userId } : {}),
        revokedAt: null,
        OR: [{ expiresAt: { gt: new Date() } }, { expiresAt: null, clientId: null }],
      },
    });
    if (!row) throw new ForbiddenException('Agent 连接已过期或撤销');
    return row;
  }
}
