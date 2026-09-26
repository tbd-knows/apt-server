import { vi } from 'vitest';
import type { AgentRuntime, AgentRuntimeEvent } from '../src/agent-runtime.js';
import type { AuthService } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import type { AgentInstance, ChatMessage, ChatRun, CreatedTurn } from '../src/domain.js';
import { AppError } from '../src/errors.js';
import type { ChatRepository } from '../src/repository.js';

export const USER_A = '11111111-1111-4111-8111-111111111111';
export const USER_B = '22222222-2222-4222-8222-222222222222';
export const RUN_ID = '33333333-3333-4333-8333-333333333333';
export const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
export const RESPONSE_ID = '55555555-5555-4555-8555-555555555555';

export const config = loadConfig({
  APT_PILOT_USER_IDS: '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222',
  NODE_ENV: 'test', LOG_LEVEL: 'silent', SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-tests', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  SUPABASE_DATABASE_URL: 'postgresql://example', HERMES_KEY_SECRET: 'x'.repeat(32),
  HERMES_MODEL: 'test', HERMES_PROVIDER_API_KEY: 'test-key',
});

export const instance: AgentInstance = {
  userId: USER_A, hermesProfileName: 'apt-user-a', hermesSessionId: '66666666-6666-4666-8666-666666666666',
  status: 'ready', createdAt: '2026-08-21T00:00:00.000Z', updatedAt: '2026-08-21T00:00:00.000Z',
};

export function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: REQUEST_ID, sequence: '1', role: 'user', content: 'hello', status: 'completed',
    clientMessageId: '77777777-7777-4777-8777-777777777777', replyToMessageId: null,
    channel: 'in_app', errorCode: null, createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z', completedAt: '2026-08-21T00:00:00.000Z', ...overrides,
  };
}

export function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    id: RUN_ID, requestMessageId: REQUEST_ID, responseMessageId: RESPONSE_ID, hermesRunId: 'hermes-run',
    status: 'completed', errorCode: null, createdAt: '2026-08-21T00:00:00.000Z',
    startedAt: '2026-08-21T00:00:00.000Z', finishedAt: '2026-08-21T00:00:01.000Z', ...overrides,
  };
}

export function turn(overrides: Partial<CreatedTurn> = {}): CreatedTurn {
  const response = message({ id: RESPONSE_ID, sequence: '2', role: 'assistant', content: '', status: 'pending',
    clientMessageId: null, replyToMessageId: REQUEST_ID, completedAt: null });
  return { requestMessage: message(), responseMessage: response, run: run({ status: 'queued', hermesRunId: null, response }), duplicate: false, ...overrides };
}

export function auth(): AuthService {
  return {
    async authenticate(token) {
      if (token === 'token-a') return { id: USER_A };
      if (token === 'token-b') return { id: USER_B };
      throw new AppError('UNAUTHENTICATED', 'A valid Supabase access token is required.');
    },
  };
}

export function repository(overrides: Partial<ChatRepository> = {}): ChatRepository {
  return {
    health: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    getAgentInstance: vi.fn(async (userId) => userId === USER_A ? instance : null),
    getChat: vi.fn(async () => ({ messages: [], olderCursor: null, activeRun: null })),
    createTurn: vi.fn(async () => turn()), getRun: vi.fn(async (userId) => {
      if (userId !== USER_A) throw new AppError('RUN_NOT_FOUND', 'Run not found.');
      return run();
    }),
    markRunRunning: vi.fn(async () => run({ status: 'running' })),
    persistAssistantSnapshot: vi.fn(async () => run({ status: 'running' })),
    completeRun: vi.fn(async () => run()), failRun: vi.fn(async () => run({ status: 'failed' })),
    markRunStopping: vi.fn(async () => run({ status: 'stopping' })),
    cancelRun: vi.fn(async () => run({ status: 'cancelled' })), failUnfinishedRuns: vi.fn(async () => []),
    upsertAgentInstance: vi.fn(async () => instance), disableAgentInstance: vi.fn(async () => ({ ...instance, status: 'disabled' as const })),
    deleteUserRecords: vi.fn(async () => undefined), ...overrides,
  };
}

export function runtime(events: AgentRuntimeEvent[] = []): AgentRuntime {
  return {
    submit: vi.fn(async () => ({ runId: 'hermes-run' })), getState: vi.fn(async () => ({ status: 'completed', output: 'done' })),
    async *stream() { for (const event of events) yield event; }, stop: vi.fn(async () => undefined), health: vi.fn(async () => undefined),
  };
}
