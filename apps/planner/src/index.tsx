/** @jsxImportSource hono/jsx */
/**
 * The planner: an app for the users of the IdP that turns "I want to build
 * this feature" into an implementation plan for maronn-openid-connect.
 *
 * A request fires the Claude Code routine (src/routine/fire.ts). The routine
 * reads the repository in its cloud session and sends the plan, or the
 * questions it needs answered first, back to /api/routine/runs/... where this
 * app stores it and shows it as Markdown. People edit and comment on the
 * plan, and once it holds, the routine turns it into a prompt for an AI
 * coding agent. A thread can be shared: anyone with its URL (/s/{token})
 * reads it, posts and comments without signing in.
 */
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { requireUser, type AppVariables } from './auth/session.js';
import { ConfigError, readConfig, type Bindings } from './env.js';
import { authRoutes } from './routes/auth.js';
import { planRoutes } from './routes/plans.js';
import { routineApi } from './routes/routine-api.js';
import { sharedThreadRoutes } from './routes/thread.js';
import { ErrorPage } from './views/pages.js';

type AppEnv = { Bindings: Bindings; Variables: AppVariables };

const app = new Hono<AppEnv>();

app.onError((error, c) => {
  // Responses thrown on purpose, such as the 403 of the CSRF check.
  if (error instanceof HTTPException) return error.getResponse();
  console.error('[planner] unhandled error:', error);
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'server_error' }, 500);
  return c.html(<ErrorPage title="エラーが発生しました" message="時間をおいてもう一度お試しください。" />, 500);
});

app.get('/health', (c) => c.json({ status: 'ok' }));

app.use('*', async (c, next) => {
  try {
    c.set('config', readConfig(c.env));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('[planner] configuration error:', error.message);
      return c.text(`設定エラー: ${error.message}`, 500);
    }
    throw error;
  }
  await next();
  if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
    const issuerOrigin = new URL(c.get('config').issuer).origin;
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
        // Mermaid writes inline styles into the diagrams it draws.
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "img-src 'self' https: data:",
        "font-src 'self' https://cdn.jsdelivr.net",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        // Sign-out posts to /auth/logout, which redirects to the IdP's end session endpoint.
        `form-action 'self' ${issuerOrigin}`,
        "frame-ancestors 'none'",
      ].join('; '),
    );
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'same-origin');
  }
  c.header('X-Content-Type-Options', 'nosniff');
});

// Called by the routine with its bearer token, not by a browser: no session, no CSRF check.
app.route('/', routineApi);

// Form posts must come from this app's own pages.
app.use('*', csrf({ origin: (origin, c) => origin === c.get('config').appOrigin }));

app.route('/', authRoutes);

// The share links: no sign-in, the URL is the key.
app.route('/', sharedThreadRoutes);

app.use('*', requireUser());
app.route('/', planRoutes);

app.notFound((c) => c.html(<ErrorPage title="ページが見つかりません" message="URL を確認してください。" />, 404));

export default app;
