import { describe, expect, it, vi } from 'vitest';
import { RunManager } from '../src/run-manager.js';
import { instance, repository, run, runtime, turn, USER_A } from './fixtures.js';

const logger = { info: vi.fn(), error: vi.fn() };

describe('RunManager', () => {
  it('finishes private memory reconciliation before releasing the run for an owner/A2A follow-up', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reconcile = vi.fn(async () => gate);
    const repo = repository();
    const agent = { ...runtime([{ type: 'completed' as const, output: 'ready' }]), reconcile };
    const manager = new RunManager(repo, agent, logger);
    manager.begin(USER_A, instance, turn());
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    expect(repo.completeRun).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(repo.completeRun).toHaveBeenCalledOnce());
    expect(reconcile).toHaveBeenCalledOnce();
  });
  it('translates streamed deltas and persists the terminal assistant response', async () => {
    const repo = repository({
      getRun: vi.fn(async () => run({ status: 'queued', hermesRunId: null })),
      completeRun: vi.fn(async (_userId, _runId, content) => run({ status: 'completed', response: turn().responseMessage, errorCode: null, finishedAt: '2026-08-21T00:00:01.000Z' })),
    });
    const agentRuntime = runtime([
      { type: 'delta', delta: 'hello ' },
      { type: 'delta', delta: 'world' },
      { type: 'completed', output: 'hello world' },
    ]);
    const manager = new RunManager(repo, agentRuntime, logger);
    const events = manager.events(USER_A, turn().run.id)[Symbol.asyncIterator]();

    expect((await events.next()).value).toMatchObject({ type: 'run.snapshot' });
    manager.begin(USER_A, instance, turn());
    const streamed = [];
    for (;;) {
      const event = await events.next();
      if (event.done) break;
      streamed.push(event.value);
    }

    expect(streamed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant.delta', delta: 'hello ' }),
      expect.objectContaining({ type: 'assistant.delta', delta: 'world' }),
      expect.objectContaining({ type: 'run.completed' }),
    ]));
    expect(repo.completeRun).toHaveBeenCalledWith(USER_A, turn().run.id, 'hello world');
  });

  it('marks unfinished rows failed on startup and stops known Hermes runs once', async () => {
    const repo = repository({
      failUnfinishedRuns: vi.fn(async () => [{ runId: turn().run.id, hermesRunId: 'hermes-run', instance }]),
    });
    const agentRuntime = runtime();
    const manager = new RunManager(repo, agentRuntime, logger);
    await manager.recoverAfterRestart();
    expect(repo.failUnfinishedRuns).toHaveBeenCalledOnce();
    expect(agentRuntime.stop).toHaveBeenCalledWith(instance, 'hermes-run');
  });
});
