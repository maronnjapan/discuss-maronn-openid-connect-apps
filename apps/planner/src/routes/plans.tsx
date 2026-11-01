/** @jsxImportSource hono/jsx */
/**
 * The pages of the signed-in user: the plans, a new request and the setup
 * guide. The pages of one thread are in ./thread.tsx, shared with the
 * visitors of its share link.
 */
import { Hono } from 'hono';
import type { AppVariables, CurrentUser } from '../auth/session.js';
import { composeRequest, formString, LIMITS, type NewPlanValues } from '../compose.js';
import { addMessage, createThread, listThreads } from '../db.js';
import type { AppConfig, Bindings } from '../env.js';
import { renderMarkdown } from '../markdown.js';
import { routineAllowedDomains, routineNetworkSecret, routinePrompt } from '../routine/prompt.js';
import { runBlocker, startRun } from '../service.js';
import { DashboardPage, NewPlanPage, SetupPage } from '../views/pages.js';
import { ownerThreadRoutes } from './thread.js';

type AppEnv = { Bindings: Bindings; Variables: AppVariables };

export const planRoutes = new Hono<AppEnv>();

planRoutes.get('/', async (c) => {
  const threads = await listThreads(c.env.DB, c.get('user').sub);
  return c.html(<DashboardPage user={c.get('user')} threads={threads} routineConfigured={c.get('config').routine !== null} />);
});

planRoutes.get('/plans/new', (c) => c.html(<NewPlanPage user={c.get('user')} />));

planRoutes.post('/plans', async (c) => {
  const user = c.get('user');
  const config = c.get('config');
  const form = await c.req.parseBody();
  const values: NewPlanValues = {
    title: formString(form, 'title').replace(/\s+/g, ' '),
    feature: formString(form, 'feature'),
    specs: formString(form, 'specs'),
    notes: formString(form, 'notes'),
  };
  const invalid =
    !values.title || !values.feature
      ? '機能の名前と、作りたい機能の説明を入力してください。'
      : values.title.length > LIMITS.title ||
          values.feature.length > LIMITS.feature ||
          values.specs.length > LIMITS.specs ||
          values.notes.length > LIMITS.notes
        ? '入力が長すぎます。'
        : null;
  if (invalid) return c.html(<NewPlanPage user={user} values={values} error={invalid} />, 400);

  const blocker = await runBlocker(c.env.DB, config, user.sub, null);
  if (blocker) return c.html(<NewPlanPage user={user} values={values} error={blocker} />, 429);

  const author = { sub: user.sub, name: user.name ?? user.sub };
  const thread = await createThread(c.env.DB, { ownerSub: user.sub, ownerName: user.name, title: values.title });
  const message = await addMessage(c.env.DB, {
    threadId: thread.id,
    role: 'user',
    kind: 'request',
    title: values.title,
    body: composeRequest(values),
    author,
  });
  await startRun(c.env.DB, config, { thread, triggerMessage: message, requester: author });
  return c.redirect(`/plans/${thread.id}`, 303);
});

/** The preview tab of the Markdown fields: the same renderer as the thread page. */
planRoutes.post('/api/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { markdown?: unknown };
  const markdown = typeof body.markdown === 'string' ? body.markdown.slice(0, 50_000) : '';
  return c.json({ html: renderMarkdown(markdown, { idPrefix: 'preview' }).html });
});

planRoutes.get('/setup', (c) => {
  const config: AppConfig = c.get('config');
  const prompt = routinePrompt({ appOrigin: config.appOrigin });
  const secret = routineNetworkSecret({ appOrigin: config.appOrigin });
  const user: CurrentUser = c.get('user');
  return c.html(
    <SetupPage
      user={user}
      prompt={prompt}
      promptHtml={renderMarkdown(prompt, { idPrefix: 'prompt' }).html}
      status={{
        appOrigin: config.appOrigin,
        issuer: config.issuer,
        clientId: config.clientId,
        routineConfigured: config.routine !== null,
        routineFireUrl: config.routine?.fireUrl ?? null,
        runsPerHourLimit: config.runsPerHourLimit,
        runTimeoutMinutes: Math.round(config.runTimeoutSeconds / 60),
        allowedSubs: config.allowedSubs,
        routineBearerTokenConfigured: config.routineBearerTokenHash !== null,
        allowedDomains: routineAllowedDomains(config.appOrigin),
        networkSecret: secret,
      }}
    />,
  );
});

planRoutes.route('/', ownerThreadRoutes);
