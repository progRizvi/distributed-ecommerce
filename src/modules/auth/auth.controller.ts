import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../../shared/errors/app-error.js';
import type { LoginBody, RegisterBody } from './auth.schema.js';
import type { AuthService } from './auth.service.js';
import type { AuthSession, RequestContext } from './auth.types.js';

export const REFRESH_COOKIE = 'refresh_token';
// Browser sends the refresh cookie only to auth endpoints.
const COOKIE_PATH = '/api/auth';

export interface AuthControllerDeps {
  service: AuthService;
  secureCookies: boolean;
}

// HTTP layer: reads the request, calls the service, writes cookies. No business logic here.
// Routes call these as controller.method(...) (never detached), so `this` is always correct.
export class AuthController {
  private readonly service: AuthService;
  private readonly secureCookies: boolean;

  constructor({ service, secureCookies }: AuthControllerDeps) {
    this.service = service;
    this.secureCookies = secureCookies;
  }

  async register(body: RegisterBody, req: FastifyRequest, reply: FastifyReply) {
    const session = await this.service.register(body, this.contextOf(req));
    this.setRefreshCookie(reply, session);
    return this.toBody(session);
  }

  async login(body: LoginBody, req: FastifyRequest, reply: FastifyReply) {
    const session = await this.service.login(body, this.contextOf(req));
    this.setRefreshCookie(reply, session);
    return this.toBody(session);
  }

  async emailAvailable(email: string) {
    return { available: await this.service.emailAvailable(email) };
  }

  async refresh(req: FastifyRequest, reply: FastifyReply) {
    const token = this.readRefreshToken(req);
    if (!token) throw new UnauthorizedError('Invalid refresh token');
    try {
      const session = await this.service.refresh(token, this.contextOf(req));
      this.setRefreshCookie(reply, session);
      return this.toBody(session);
    } catch (error) {
      this.clearRefreshCookie(reply);
      throw error;
    }
  }

  async logout(req: FastifyRequest, reply: FastifyReply) {
    const token = this.readRefreshToken(req);
    if (token) await this.service.logout(token);
    this.clearRefreshCookie(reply);
  }

  async logoutAll(userId: string, reply: FastifyReply) {
    await this.service.logoutAll(userId);
    this.clearRefreshCookie(reply);
  }

  async me(userId: string) {
    return { user: await this.service.me(userId) };
  }

  private contextOf(req: FastifyRequest): RequestContext {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  private setRefreshCookie(reply: FastifyReply, session: AuthSession): void {
    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true, // JavaScript cannot read it (XSS cannot steal it)
      secure: this.secureCookies,
      sameSite: 'strict', // not sent from other sites (CSRF)
      signed: true,
      path: COOKIE_PATH,
      expires: session.refreshExpiresAt,
    });
  }

  private clearRefreshCookie(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  }

  private readRefreshToken(req: FastifyRequest): string | undefined {
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) return undefined;
    const result = req.unsignCookie(raw);
    return result.valid && result.value ? result.value : undefined;
  }

  // Refresh token goes to the cookie only, never in the JSON body.
  private toBody(session: AuthSession) {
    return {
      user: session.user,
      accessToken: session.accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: session.expiresIn,
    };
  }
}
