import type { AgentRuntime } from './agent-runtime.js';
import type { AgentInstance, ChatRun, CreatedTurn, PublicRunEvent } from './domain.js';
import { AppError } from './errors.js';
import type { ChatRepository } from './repository.js';
import type { MemoryToolName, RunContext } from './memory/domain.js';
import type { MemoryService } from './memory/service.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

class RunChannel {
  private readonly subscribers = new Set<(event: PublicRunEvent) => void>();
  private terminalEvent: PublicRunEvent | null = null;

  publish(event: PublicRunEvent) {
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      this.terminalEvent = event;
    }
    for (const subscriber of this.subscribers) subscriber(event);
  }

  async *events(): AsyncIterable<PublicRunEvent> {
    if (this.terminalEvent) {
      yield this.terminalEvent;
      return;
    }
    const queue: PublicRunEvent[] = [];
    let wake: (() => void) | undefined;
    const subscriber = (event: PublicRunEvent) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };
    this.subscribers.add(subscriber);
    try {
      while (true) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
        const event = queue.shift();
        if (!event) continue;
        yield event;
        if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') return;
      }
    } finally {
      this.subscribers.delete(subscriber);
    }
  }
}

export class RunManager {
  private readonly channels = new Map<string, RunChannel>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly activeContexts = new Map<string, { instance: AgentInstance; context: RunContext; toolSteps: number }>();

  constructor(
    private readonly repository: ChatRepository,
    private readonly runtime: AgentRuntime,
    private readonly logger: { info(data: object, message: string): void; error(data: object, message: string): void },
    private readonly memoryService?: MemoryService,
  ) {}

  begin(userId: string, instance: AgentInstance, turn: CreatedTurn) {
    if (turn.duplicate || this.tasks.has(turn.run.id)) return;
    const channel = this.channel(turn.run.id);
    const context: RunContext = {
      userId,
      runId: turn.run.id,
      requestMessageId: turn.requestMessage.id,
    };
    this.activeContexts.set(instance.hermesProfileName, { instance, context, toolSteps: 0 });
    const task = this.execute(userId, instance, turn, channel, context)
      .catch((error: unknown) => {
        this.logger.error({ error, runId: turn.run.id, userId }, 'Run execution crashed');
      })
      .finally(() => {
        this.tasks.delete(turn.run.id);
        if (this.activeContexts.get(instance.hermesProfileName)?.context.runId === turn.run.id) this.activeContexts.delete(instance.hermesProfileName);
      });
    this.tasks.set(turn.run.id, task);
  }

  private async execute(userId: string, instance: AgentInstance, turn: CreatedTurn, channel: RunChannel, context: RunContext) {
    let accumulated = '';
    let lastPersistedAt = 0;
    let reconciled = false;
    const reconcile = async () => {
      if (reconciled) return;
      reconciled = true;
      if (this.activeContexts.get(instance.hermesProfileName)?.context.runId === turn.run.id) this.activeContexts.delete(instance.hermesProfileName);
      try { await this.runtime.reconcile?.(instance, context); } catch (error) {
        this.logger.error({ error, runId: turn.run.id, userId }, 'Private memory reconciliation failed');
      }
    };
    try {
      const submitted = await this.runtime.submit(instance, turn.requestMessage.content, { context });
      const current = await this.repository.getRun(userId, turn.run.id);
      if (current.status === 'stopping') {
        await this.runtime.stop(instance, submitted.runId);
      } else {
        await this.repository.markRunRunning(userId, turn.run.id, submitted.runId);
      }
      this.logger.info({ runId: turn.run.id, userId }, 'Hermes run submitted');

      for await (const event of this.runtime.stream(instance, submitted.runId)) {
        if (event.type === 'delta') {
          accumulated += event.delta;
          channel.publish({
            type: 'assistant.delta',
            runId: turn.run.id,
            messageId: turn.responseMessage.id,
            delta: event.delta,
          });
          const now = Date.now();
          if (now - lastPersistedAt >= 1_000) {
            await this.repository.persistAssistantSnapshot(userId, turn.run.id, accumulated);
            lastPersistedAt = now;
          }
        } else if (event.type === 'completed') {
          await reconcile();
          const run = await this.repository.completeRun(userId, turn.run.id, event.output || accumulated);
          channel.publish({ type: 'run.completed', run });
          return;
        } else if (event.type === 'cancelled') {
          await reconcile();
          const run = await this.repository.cancelRun(userId, turn.run.id, accumulated);
          channel.publish({ type: 'run.cancelled', run });
          return;
        } else if (event.type === 'failed') {
          await reconcile();
          const run = await this.repository.failRun(userId, turn.run.id, 'UPSTREAM_FAILED');
          channel.publish({ type: 'run.failed', run });
          return;
        }
      }

      const state = await this.runtime.getState(instance, submitted.runId);
      await reconcile();
      if (state.status === 'completed') {
        const run = await this.repository.completeRun(userId, turn.run.id, state.output ?? accumulated);
        channel.publish({ type: 'run.completed', run });
      } else if (state.status === 'cancelled') {
        const run = await this.repository.cancelRun(userId, turn.run.id, accumulated);
        channel.publish({ type: 'run.cancelled', run });
      } else {
        const run = await this.repository.failRun(userId, turn.run.id, 'UPSTREAM_FAILED');
        channel.publish({ type: 'run.failed', run });
      }
    } catch (error) {
      this.logger.error({ error, runId: turn.run.id, userId }, 'Hermes run failed');
      await reconcile();
      const run = await this.repository.failRun(userId, turn.run.id, 'UPSTREAM_FAILED');
      channel.publish({ type: 'run.failed', run });
    } finally {
      await reconcile();
    }
  }

  async invokeAgentTool(profileName: string, tool: MemoryToolName, argumentsValue: unknown) {
    if (!this.memoryService) throw new AppError('UPSTREAM_FAILED', 'The agent tool bridge is not configured.');
    const active = this.activeContexts.get(profileName);
    if (!active) throw new AppError('RUN_NOT_FOUND', 'No active run is bound to this agent profile.');
    if (++active.toolSteps > 24) throw new AppError('COMMERCE_CONFLICT', 'Tool limit reached. Pause and ask your owner.');
    return this.memoryService.invoke(active.context, tool, argumentsValue);
  }

  async *events(userId: string, runId: string): AsyncIterable<PublicRunEvent> {
    const run = await this.repository.getRun(userId, runId);
    yield { type: 'run.snapshot', run };
    if (TERMINAL.has(run.status)) return;
    yield* this.channel(runId).events();
  }

  async stop(userId: string, runId: string) {
    const run = await this.repository.getRun(userId, runId);
    if (TERMINAL.has(run.status)) return run;
    const instance = await this.repository.getAgentInstance(userId);
    if (!instance) throw new AppError('AGENT_NOT_PROVISIONED', 'Apt chat has not been provisioned for this user.');
    if (instance.status === 'disabled') throw new AppError('AGENT_DISABLED', 'Apt chat is disabled for this user.');
    const stopping = await this.repository.markRunStopping(userId, runId);
    if (run.hermesRunId) await this.runtime.stop(instance, run.hermesRunId);
    return stopping;
  }

  async recoverAfterRestart() {
    const restarted = await this.repository.failUnfinishedRuns();
    await Promise.allSettled(
      restarted
        .filter((item) => item.hermesRunId)
        .map((item) => this.runtime.stop(item.instance, item.hermesRunId!)),
    );
    if (restarted.length) this.logger.info({ count: restarted.length }, 'Failed unfinished runs after restart');
  }

  private channel(runId: string) {
    let channel = this.channels.get(runId);
    if (!channel) {
      channel = new RunChannel();
      this.channels.set(runId, channel);
    }
    return channel;
  }
}
