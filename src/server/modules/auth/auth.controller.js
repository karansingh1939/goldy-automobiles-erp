import { env } from '../../config/env.js';
import { respond } from '../../shared/http/respond.js';

export class AuthController {
  constructor(authService) {
    this.authService = authService;
  }

  getSetupStatus = respond(() => this.authService.getSetupStatus());

  setup = respond((req) => this.authService.setupAdmin(req.body || {}), 201);

  forgotPassword = respond((req) => this.authService.forgotPassword(req.body || {}));

  login = respond(async (req, res) => {
    const result = await this.authService.login(req.body || {});
    res.cookie('goldy_session_token', result.token, {
      path: '/',
      httpOnly: true,
      secure: false, // the app is served over plain HTTP on this laptop only
      sameSite: 'strict',
      maxAge: (env.sessionTtlHours || 12) * 60 * 60 * 1000,
    });
    return result;
  });

  logout = respond((req, res) => {
    this.authService.logout(req.authToken);
    res.clearCookie('goldy_session_token', { path: '/' });
    return { success: true };
  });

  /** Who is signed in (used to check that a session is still valid). */
  me = respond((req) => ({ user: req.user }));
}
