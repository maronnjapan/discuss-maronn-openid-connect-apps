import { describe, expect, it } from 'vitest';
import type { RunRow } from '../src/db.js';
import type { AppConfig } from '../src/env.js';
import type { CallbackMessage } from '../src/routine/callback.js';
import { recordCallback, taskFor } from '../src/service.js';

// The kinds are checked before the database is touched, so no database is needed here.
const noDatabase = new Proxy({}, { get: () => { throw new Error('the database must not be used'); } }) as D1Database;
const config = { appOrigin: 'https://planner.example.com' } as AppConfig;
const run = (task: RunRow['task']) => ({ id: 'run_0123456789abcdef01234567', thread_id: 'thr_1', task }) as RunRow;
const message = (kind: CallbackMessage['kind']): CallbackMessage => ({ kind, markdown: '# x', questions: [], commentReplies: [] });

describe('recordCallback', () => {
  it('should refuse a plan from a run that turns the plan into a prompt', async () => {
    expect(await recordCallback(noDatabase, config, run('implementation_prompt'), message('plan'))).toEqual({
      status: 400,
      error: 'invalid_request',
      description: '"kind" must be one of implementation_prompt, progress, error for this run (task "implementation_prompt").',
    });
  });

  it('should refuse an implementation prompt from a run that works on the plan', async () => {
    expect(await recordCallback(noDatabase, config, run('plan'), message('implementation_prompt'))).toEqual({
      status: 400,
      error: 'invalid_request',
      description: '"kind" must be one of plan, questions, progress, error for this run (task "plan").',
    });
  });
});

describe('taskFor', () => {
  it('should start a prompt run for a prompt request and a plan run for anything else', () => {
    expect(taskFor({ kind: 'prompt_request' })).toBe('implementation_prompt');
    expect(taskFor({ kind: 'request' })).toBe('plan');
    expect(taskFor({ kind: 'reply' })).toBe('plan');
  });
});
