import { createHmac } from 'node:crypto';
import type { AgentInstance } from './domain.js';
import { AppError } from './errors.js';
import type { ConversationMessage, RunContext } from './memory/domain.js';

export type AgentRuntimeEvent =
  | { type: 'delta'; delta: string }
  | { type: 'completed'; output: string }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' };

export interface AgentRuntime {
  submit(instance: AgentInstance, input: string, options?: AgentSubmitOptions): Promise<{ runId: string }>;
  getState(instance: AgentInstance, runId: string): Promise<{ status: string; output?: string }>;
  stream(instance: AgentInstance, runId: string): AsyncIterable<AgentRuntimeEvent>;
  stop(instance: AgentInstance, runId: string): Promise<void>;
  health(): Promise<void>;
  reconcile?(instance: AgentInstance, context?: RunContext): Promise<void>;
}

export interface AgentSubmitOptions {
  context?: RunContext;
  instructions?: string;
  conversationHistory?: ConversationMessage[];
}

export interface HermesRuntimeConfig {
  baseUrl: string;
  topology: 'shared' | 'per_profile';
  profileUrlTemplate: string;
  profileUrls?: Record<string, string>;
  keySecret: string;
  timeoutMs?: number;
}

export function hermesApiKey(profile: string, secret: string) {
  return createHmac('sha256', secret).update(`apt-hermes-api:${profile}`).digest('base64url');
}

export class HermesAgentRuntime implements AgentRuntime {
  private readonly timeoutMs: number;

  constructor(private readonly config: HermesRuntimeConfig) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private profileBaseUrl(instance: AgentInstance) {
    if (this.config.topology === 'shared') {
      return `${this.config.baseUrl}/p/${encodeURIComponent(instance.hermesProfileName)}`;
    }
    const configured = this.config.profileUrls?.[instance.hermesProfileName];
    if (configured) return configured.replace(/\/$/, '');
    return this.config.profileUrlTemplate.replace('{profile}', encodeURIComponent(instance.hermesProfileName)).replace(/\/$/, '');
  }

  private headers(instance: AgentInstance) {
    return {
      Authorization: `Bearer ${hermesApiKey(instance.hermesProfileName, this.config.keySecret)}`,
      'Content-Type': 'application/json',
      'X-Hermes-Session-Key': `apt:${instance.hermesProfileName}`,
    };
  }

  private async request(instance: AgentInstance, path: string, init: RequestInit = {}, useTimeout = true) {
    const response = await fetch(`${this.profileBaseUrl(instance)}${path}`, {
      ...init,
      headers: { ...this.headers(instance), ...(init.headers ?? {}) },
      ...(useTimeout ? { signal: init.signal ?? AbortSignal.timeout(this.timeoutMs) } : {}),
    });
    if (!response.ok) {
      throw new AppError('UPSTREAM_FAILED', `Hermes request failed with status ${response.status}.`);
    }
    return response;
  }

  async submit(instance: AgentInstance, input: string, options?: AgentSubmitOptions) {
    let conversationHistory = options?.conversationHistory;
    if (!conversationHistory) {
      const historyResponse = await this.request(
        instance,
        `/api/sessions/${encodeURIComponent(instance.hermesSessionId)}/messages?limit=500&order=latest`,
      );
      const historyBody = (await historyResponse.json()) as { data?: Array<{ role?: unknown; content?: unknown }> };
      if (!Array.isArray(historyBody.data)) throw new AppError('UPSTREAM_FAILED', 'Hermes did not return session history.');
      const rows = historyBody.data
        .filter((message): message is { role: 'user' | 'assistant'; content: string } =>
          (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
        .map(({ role, content }) => ({ role, content }));
      conversationHistory = boundConversationHistory(rows, 48_000);
    }
    const response = await this.request(instance, '/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        input,
        session_id: instance.hermesSessionId,
        conversation_history: conversationHistory,
        ...(options?.instructions ? { instructions: options.instructions } : {}),
      }),
    });
    const body = (await response.json()) as { run_id?: string };
    if (!body.run_id) throw new AppError('UPSTREAM_FAILED', 'Hermes did not return a run ID.');
    return { runId: body.run_id };
  }

  async getState(instance: AgentInstance, runId: string) {
    const response = await this.request(instance, `/v1/runs/${encodeURIComponent(runId)}`);
    return (await response.json()) as { status: string; output?: string };
  }

  async *stream(instance: AgentInstance, runId: string): AsyncIterable<AgentRuntimeEvent> {
    const response = await this.request(instance, `/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: 'text/event-stream' },
    }, false);
    if (!response.body) throw new AppError('UPSTREAM_FAILED', 'Hermes returned an empty event stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseHermesFrame(frame);
          if (event) yield event;
          boundary = buffer.indexOf('\n\n');
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async stop(instance: AgentInstance, runId: string) {
    await this.request(instance, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
  }

  async health() {
    const response = await fetch(`${this.config.baseUrl}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Hermes health returned ${response.status}`);
  }
}

export function boundConversationHistory(messages: ConversationMessage[], budget: number) {
  const selected: ConversationMessage[] = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (characters + message.content.length > budget) break;
    selected.push(message);
    characters += message.content.length;
  }
  return selected.reverse();
}

export function parseHermesFrame(frame: string): AgentRuntimeEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const event = String(payload.event ?? payload.type ?? '');
  if (event === 'message.delta' && typeof payload.delta === 'string') return { type: 'delta', delta: payload.delta };
  if (event === 'run.completed') return { type: 'completed', output: typeof payload.output === 'string' ? payload.output : '' };
  if (event === 'run.failed') return { type: 'failed', error: typeof payload.error === 'string' ? payload.error : 'Hermes run failed.' };
  if (event === 'run.cancelled') return { type: 'cancelled' };
  return null;
}
