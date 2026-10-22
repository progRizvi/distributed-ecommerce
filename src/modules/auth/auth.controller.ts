import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../shared/errors/app-error.js';
import type { AuthService } from './auth.service.js';
import type { AuthSession, RequestContext } from './auth.types.js';
import type { LoginBody, RegisterBody } from './auth.schema.js';

export const REFRESH_COOKIE = 'refresh_token';
// Browser sends the refresh cookie only to auth endpoints.
const COOKIE_PATH = '/api/auth';

export interface AuthControllerDeps {
  service: AuthService;
  secureCookies: boolean;
}

// HTTP layer: reads the request, calls the service, writes cookies. No business logic here.
export function createAuthController({ service, secureCookies }: AuthControllerDeps) {
  const contextOf = (req: FastifyRequest): RequestContext => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

  function setRefreshCookie(reply: FastifyReply, session: AuthSession): void {
    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true, // JavaScript cannot read it (XSS cannot steal it)
      secure: secureCookies,
      sameSite: 'strict', // not sent from other sites (CSRF)
      signed: true,
      path: COOKIE_PATH,
      expires: session.refreshExpiresAt,
    });
  }

  function clearRefreshCookie(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  function readRefreshToken(req: FastifyRequest): string | undefined {
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) return undefined;
    const result = req.unsignCookie(raw);
    return result.valid && result.value ? result.value : undefined;
  }

  // Refresh token goes to the cookie only, never in the JSON body.
  const toBody = (session: AuthSession) => ({
    user: session.user,
    accessToken: session.accessToken,
    tokenType: 'Bearer' as const,
    expiresIn: session.expiresIn,
  });

  return {
    async register(body: RegisterBody, req: FastifyRequest, reply: FastifyReply) {
      const session = await service.register(body, contextOf(req));
      setRefreshCookie(reply, session);
      return toBody(session);
    },

    async login(body: LoginBody, req: FastifyRequest, reply: FastifyReply) {
      const session = await service.login(body, contextOf(req));
      setRefreshCookie(reply, session);
      return toBody(session);
    },

    async refresh(req: FastifyRequest, reply: FastifyReply) {
      const token = readRefreshToken(req);
      if (!token) throw new UnauthorizedError('Invalid refresh token');
      try {
        const session = await service.refresh(token, contextOf(req));
        setRefreshCookie(reply, session);
        return toBody(session);
      } catch (error) {
        clearRefreshCookie(reply);
        throw error;
      }
    },

    async logout(req: FastifyRequest, reply: FastifyReply) {
      const token = readRefreshToken(req);
      if (token) await service.logout(token);
      clearRefreshCookie(reply);
    },

    async logoutAll(userId: string, reply: FastifyReply) {
      await service.logoutAll(userId);
      clearRefreshCookie(reply);
    },

    async me(userId: string) {
      return { user: await service.me(userId) };
    },
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
