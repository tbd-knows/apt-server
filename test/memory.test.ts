import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileIdentity } from '../src/admin/service.js';
import type { AgentRuntime } from '../src/agent-runtime.js';
import { aptBridgeToken, verifyAptBridgeToken } from '../src/memory/bridge-auth.js';
import type { KnowledgeFact, MemoryTurnBundle, RunContext } from '../src/memory/domain.js';
import { LEGACY_CLAW_MARKER_FILE, LEGACY_SHARED_SKILLS_DIRECTORY, MEMORY_MARKER_FILE, MemoryMaterializer } from '../src/memory/materializer.js';
import { APP_PROMPT, APP_PROMPT_VERSION, compileMemoryTurn } from '../src/memory/prompt.js';
import { boundRecentMessages, type MemoryRepository } from '../src/memory/repository.js';
import { MemoryAgentRuntime } from '../src/memory/runtime.js';
import { MemoryService } from '../src/memory/service.js';
import { instance, runtime, USER_A, USER_B } from './fixtures.js';

function bundle(privateFact = 'private-fact', overrides: Partial<MemoryTurnBundle> = {}): MemoryTurnBundle {
  return {
    profile: { soulText: '', hotUserText: '', hotMemoryText: '', revision: '1', knowledgeRevision: '0', runtimeHash: null },
    knowledge: [{ id: 'fact', subjectKind: 'self', subjectLabel: null, category: 'preference', fact: privateFact, confidence: 0.9, learnedAt: '2026-08-22T00:00:00.000Z' }],
    conversationHistory: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function memoryRepository(overrides: Partial<MemoryRepository> = {}): MemoryRepository {
  return {
    loadTurn: vi.fn(async () => bundle()),
    setRuntimeHash: vi.fn(async () => undefined),
    searchKnowledge: vi.fn(async (): Promise<KnowledgeFact[]> => []),
    remember: vi.fn(async (_userId, _runId, _messageId, input) => ({
      id: 'fact', subjectKind: input.subjectKind, subjectLabel: input.subjectLabel, category: input.category,
      fact: input.fact, confidence: input.confidence, learnedAt: '2026-08-22T00:00:00.000Z',
    })),
    updatePrivateArtifact: vi.fn(async () => bundle().profile),
    reconcileRuntimeArtifacts: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

const context: RunContext = { userId: USER_A, runId: '33333333-3333-4333-8333-333333333333', requestMessageId: '44444444-4444-4444-8444-444444444444' };

describe('app prompt and private context compiler', () => {
  it('compiles deterministically from the versioned app prompt without any shared release', () => {
    const first = compileMemoryTurn(bundle());
    expect(compileMemoryTurn(bundle())).toEqual(first);
    expect(first.instructions.startsWith(APP_PROMPT)).toBe(true);
    expect(first.instructions).toContain(APP_PROMPT_VERSION);
    expect(first.instructions).toContain('private-fact');
    for (const retired of ['browser_navigate', 'Hunt', 'Cart', 'Wishlist', 'Board', 'Claw release', 'apt_commerce_hunt', 'apt_manage_shopping', 'apt_previous_hunts']) {
      expect(first.instructions).not.toContain(retired);
    }
  });

  it('changes the runtime hash only when the prompt version or private artifacts change', () => {
    const base = compileMemoryTurn(bundle());
    expect(compileMemoryTurn(bundle('another-fact')).runtimeHash).toBe(base.runtimeHash);
    const changed = bundle();
    changed.profile.hotMemoryText = 'remembered';
    expect(compileMemoryTurn(changed).runtimeHash).not.toBe(base.runtimeHash);
  });

  it('keeps all ten fixture identities pairwise isolated', () => {
    const users = Array.from({ length: 10 }, (_, index) => `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`);
    const identities = users.map((userId) => profileIdentity(userId, 's'.repeat(32)));
    expect(new Set(identities.map((identity) => identity.profileName)).size).toBe(10);
    expect(new Set(identities.map((identity) => identity.sessionId)).size).toBe(10);
    const compiled = users.map((_, index) => compileMemoryTurn(bundle(`secret-${index}`)));
    for (let owner = 0; owner < compiled.length; owner += 1) {
      for (let other = 0; other < compiled.length; other += 1) {
        expect(compiled[owner]!.instructions.includes(`secret-${other}`)).toBe(owner === other);
      }
    }
  });

  it('keeps whole recent messages inside the configured character budget', () => {
    const rows = [
      { role: 'assistant' as const, content: 'newest' },
      { role: 'user' as const, content: 'middle' },
      { role: 'assistant' as const, content: 'older-long' },
    ];
    expect(boundRecentMessages(rows, 12)).toEqual([
      { role: 'user', content: 'middle' }, { role: 'assistant', content: 'newest' },
    ]);
  });

  it('binds bridge credentials to opaque profiles', () => {
    const secret = 's'.repeat(32);
    const profile = 'apt-0123456789abcdef0123';
    const token = aptBridgeToken(profile, secret);
    expect(verifyAptBridgeToken(token, secret)).toBe(profile);
    expect(verifyAptBridgeToken(token, 'x'.repeat(32))).toBeNull();
  });
});

describe('memory service tool binding', () => {
  it('binds every tool to the run user and never lets arguments select another user', async () => {
    const repository = memoryRepository();
    const service = new MemoryService(repository);
    await service.invoke(context, 'apt_search_knowledge', { query: 'shoes', limit: 5, user_id: USER_B }).catch(() => undefined);
    await service.invoke(context, 'apt_search_knowledge', { query: 'shoes', limit: 5 });
    expect(repository.searchKnowledge).toHaveBeenCalledTimes(1);
    expect(repository.searchKnowledge).toHaveBeenCalledWith(USER_A, 'shoes', 5);

    const remembered = await service.invoke(context, 'apt_remember', {
      subject_kind: 'self', subject_label: null, category: 'sizing', fact: 'US men’s 10', confidence: 0.9,
    });
    expect(repository.remember).toHaveBeenCalledWith(USER_A, context.runId, context.requestMessageId, expect.objectContaining({ fact: 'US men’s 10', sensitivity: 'low' }));
    expect(remembered).toMatchObject({ fact: { category: 'sizing' } });

    await service.invoke(context, 'apt_update_private_artifact', { kind: 'memory', content: 'notes', expected_revision: '1' });
    expect(repository.updatePrivateArtifact).toHaveBeenCalledWith(USER_A, context.runId, 'memory', 'notes', '1');
  });

  it('rejects retired tools and oversized private artifacts', async () => {
    const service = new MemoryService(memoryRepository());
    await expect(service.invoke(context, 'apt_commerce_hunt' as never, {})).rejects.toThrow('Unknown agent tool');
    await expect(service.invoke(context, 'apt_manage_shopping' as never, {})).rejects.toThrow('Unknown agent tool');
    await expect(service.invoke(context, 'apt_update_private_artifact', { kind: 'user_profile', content: 'x'.repeat(1_376), expected_revision: '1' }))
      .rejects.toThrow();
  });

  it('refuses to prepare a turn for an instance owned by another user', async () => {
    const service = new MemoryService(memoryRepository());
    await expect(service.prepareTurn({ ...context, userId: USER_B }, instance, 'hello')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('private artifact materializer and runtime', () => {
  const homes: string[] = [];
  afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

  async function home() {
    const directory = await mkdtemp(join(tmpdir(), 'apt-memory-'));
    homes.push(directory);
    return directory;
  }

  it('writes only private artifacts, removes legacy Claw files, and reads artifacts back after a run', async () => {
    const hermesHome = await home();
    const owned = { ...instance, hermesProfileName: profileIdentity(USER_A, 's'.repeat(32)).profileName };
    const profileRoot = join(hermesHome, 'profiles', owned.hermesProfileName);
    await mkdir(join(profileRoot, LEGACY_SHARED_SKILLS_DIRECTORY, 'apt-commerce'), { recursive: true });
    await mkdir(join(profileRoot, 'skills', 'private.gifts'), { recursive: true });
    await writeFile(join(profileRoot, 'skills', 'private.gifts', 'SKILL.md'), '# retained\n');
    const materializer = new MemoryMaterializer(hermesHome);
    expect(await materializer.readCompletedPrivateArtifacts(owned)).toBeNull();

    const written = await materializer.materialize(owned, { soulText: 'soul', hotUserText: 'user', hotMemoryText: 'memory' }, 'a'.repeat(64));
    expect(written).toBe(true);
    expect(await readFile(join(profileRoot, 'SOUL.md'), 'utf8')).toBe('soul');
    expect(await readFile(join(profileRoot, 'memories', 'USER.md'), 'utf8')).toBe('user');
    expect(await readFile(join(profileRoot, 'memories', 'MEMORY.md'), 'utf8')).toBe('memory');
    const entries = await readdir(profileRoot);
    expect(entries).toContain(MEMORY_MARKER_FILE);
    expect(entries).not.toContain(LEGACY_CLAW_MARKER_FILE);
    expect(entries).not.toContain(LEGACY_SHARED_SKILLS_DIRECTORY);
    expect(await readdir(join(profileRoot, 'skills'))).toEqual(['private.gifts']);

    expect(await materializer.materialize(owned, { soulText: 'soul', hotUserText: 'user', hotMemoryText: 'memory' }, 'a'.repeat(64))).toBe(false);
    await writeFile(join(profileRoot, 'memories', 'MEMORY.md'), 'memory-updated-by-hermes');
    expect(await materializer.readCompletedPrivateArtifacts(owned)).toEqual({ soulText: 'soul', hotUserText: 'user', hotMemoryText: 'memory-updated-by-hermes' });
  });

  it('refuses to materialize into an invalid profile directory name', async () => {
    const materializer = new MemoryMaterializer(await home());
    await expect(materializer.materialize({ ...instance, hermesProfileName: '../escape' }, { soulText: '', hotUserText: '', hotMemoryText: '' }, 'a'.repeat(64)))
      .rejects.toThrow('invalid Hermes profile name');
  });

  it('reconciles, compiles, materializes, and submits with owner-scoped instructions and history', async () => {
    const hermesHome = await home();
    const identity = profileIdentity(USER_A, 's'.repeat(32));
    const owned = { ...instance, hermesProfileName: identity.profileName };
    const profileRoot = join(hermesHome, 'profiles', owned.hermesProfileName);
    await mkdir(join(profileRoot, 'memories'), { recursive: true });
    await writeFile(join(profileRoot, MEMORY_MARKER_FILE), '{"runtimeHash":"stale"}');
    await writeFile(join(profileRoot, 'memories', 'MEMORY.md'), 'learned last turn');
    const repository = memoryRepository({
      loadTurn: vi.fn(async () => bundle('likes white sneakers', {
        profile: { soulText: 'be brief', hotUserText: '', hotMemoryText: 'learned last turn', revision: '2', knowledgeRevision: '1', runtimeHash: null },
        conversationHistory: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
      })),
    });
    const inner: AgentRuntime = runtime();
    const service = new MemoryService(repository);
    const agent = new MemoryAgentRuntime(inner, service, new MemoryMaterializer(hermesHome));

    await expect(agent.submit(owned, 'hello')).rejects.toThrow('server-owned run context');
    await agent.submit(owned, 'hello', { context });

    expect(repository.reconcileRuntimeArtifacts).toHaveBeenCalledWith(USER_A, expect.objectContaining({ hotMemoryText: 'learned last turn' }));
    expect(repository.setRuntimeHash).toHaveBeenCalledOnce();
    expect(await readFile(join(profileRoot, 'SOUL.md'), 'utf8')).toBe('be brief');
    expect(inner.submit).toHaveBeenCalledWith(owned, 'hello', expect.objectContaining({
      instructions: expect.stringContaining('likes white sneakers'),
      conversationHistory: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }],
    }));
    const submitted = vi.mocked(inner.submit).mock.calls[0]![2]!;
    expect(submitted.instructions).toContain(APP_PROMPT_VERSION);
    expect(submitted.instructions).not.toContain('apt_commerce_hunt');

    await agent.reconcile(owned, context);
    expect(repository.reconcileRuntimeArtifacts).toHaveBeenCalledTimes(2);
  });
});
