import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesCliProfileAdmin, profileIdentity } from '../src/admin/service.js';
import type { RuntimePrivateArtifacts } from '../src/memory/domain.js';
import { removeLegacySharedSkills, LEGACY_SHARED_SKILLS_DIRECTORY } from '../src/memory/legacy-cleanup.js';
import { LEGACY_CLAW_MARKER_FILE, LEGACY_MEMORY_BACKUP_FILE, MEMORY_MARKER_FILE, MemoryMaterializer } from '../src/memory/materializer.js';
import type { MemoryRepository } from '../src/memory/repository.js';
import { MemoryAgentRuntime } from '../src/memory/runtime.js';
import { MemoryService } from '../src/memory/service.js';
import { config, instance, runtime, USER_A, USER_B, RUN_ID, REQUEST_ID } from './fixtures.js';

const owned = { ...instance, hermesProfileName: profileIdentity(USER_A, config.hermes.keySecret).profileName };
const context = { userId: USER_A, runId: RUN_ID, requestMessageId: REQUEST_ID };
const original = { soulText: 'A private soul', hotUserText: 'A private user', hotMemoryText: 'A unreconciled memory' };
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    // Even a failed assertion must clean up the intentionally read-only fixture.
    await removeLegacySharedSkills(join(home, 'profiles', owned.hermesProfileName)).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'apt-upgrade-'));
  homes.push(home);
  const root = join(home, 'profiles', owned.hermesProfileName);
  await mkdir(join(root, 'memories'), { recursive: true });
  await writeFile(join(root, LEGACY_CLAW_MARKER_FILE), '{"runtimeHash":"old"}');
  await writeFile(join(root, 'SOUL.md'), original.soulText);
  await writeFile(join(root, 'memories', 'USER.md'), original.hotUserText);
  await writeFile(join(root, 'memories', 'MEMORY.md'), original.hotMemoryText);
  await mkdir(join(root, 'skills', 'private.saved'), { recursive: true });
  await writeFile(join(root, 'skills', 'private.saved', 'SKILL.md'), 'private skill');
  const mount = join(root, LEGACY_SHARED_SKILLS_DIRECTORY);
  const skill = join(mount, 'apt-commerce');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), 'retired skill', { mode: 0o400 });
  await chmod(skill, 0o500);
  await chmod(mount, 0o500);
  return { home, root, mount };
}

function repository() {
  let artifacts: RuntimePrivateArtifacts = { ...original, hotMemoryText: 'stale DB memory' };
  const repo = {
    loadTurn: vi.fn(async () => ({ profile: { ...artifacts, revision: '2', knowledgeRevision: '0', runtimeHash: 'old' }, knowledge: [], conversationHistory: [] })),
    setRuntimeHash: vi.fn(async () => undefined),
    reconcileRuntimeArtifacts: vi.fn(async (userId: string, next: RuntimePrivateArtifacts) => {
      expect(userId).toBe(USER_A);
      artifacts = { ...next };
    }),
  };
  return repo;
}

describe('pre-pivot filesystem upgrade', () => {
  it('re-provisions read-only mounts twice without deleting the marker, private memory, or symlink targets', async () => {
    const { home, root, mount } = await fixture();
    const outside = join(home, 'other-owner');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'other owner');
    await chmod(mount, 0o700);
    await symlink(outside, join(mount, 'external'));
    await chmod(mount, 0o500);
    const beforeMode = (await stat(outside)).mode;
    // Execute the real configure/file cleanup path; only the external CLI is a no-op.
    const admin = new HermesCliProfileAdmin({ ...config.hermes, home, cli: '/usr/bin/true' });
    await admin.configure(owned.hermesProfileName);
    await admin.configure(owned.hermesProfileName);
    expect(await readdir(root)).not.toContain(LEGACY_SHARED_SKILLS_DIRECTORY);
    expect(await readFile(join(root, LEGACY_CLAW_MARKER_FILE), 'utf8')).toContain('old');
    expect(await readFile(join(root, 'memories', 'MEMORY.md'), 'utf8')).toBe(original.hotMemoryText);
    expect(await readFile(join(root, 'skills', 'private.saved', 'SKILL.md'), 'utf8')).toBe('private skill');
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('other owner');
    expect((await stat(outside)).mode).toBe(beforeMode);
  });

  it('migrates the first turn before overwriting, keeps a private backup, and survives restart/retry', async () => {
    const { home, root } = await fixture();
    const repo = repository();
    const inner = runtime();
    const service = new MemoryService(repo as unknown as MemoryRepository);
    const makeRuntime = () => new MemoryAgentRuntime(inner, service, new MemoryMaterializer(home));
    await makeRuntime().submit(owned, 'hello', { context });
    expect(repo.reconcileRuntimeArtifacts).toHaveBeenCalledWith(USER_A, original);
    expect(inner.submit).toHaveBeenCalledWith(owned, 'hello', expect.objectContaining({ instructions: expect.stringContaining(original.hotMemoryText) }));
    expect(await readFile(join(root, 'memories', 'MEMORY.md'), 'utf8')).toBe(original.hotMemoryText);
    expect(await readdir(root)).not.toContain(LEGACY_CLAW_MARKER_FILE);
    expect(JSON.parse(await readFile(join(root, LEGACY_MEMORY_BACKUP_FILE), 'utf8'))).toEqual(original);
    expect((await stat(join(root, LEGACY_MEMORY_BACKUP_FILE))).mode & 0o777).toBe(0o600);
    // The recovery backup must not replace newer post-migration memory.
    await writeFile(join(root, 'memories', 'MEMORY.md'), 'new post-pivot memory');
    await makeRuntime().submit(owned, 'again', { context });
    expect(repo.reconcileRuntimeArtifacts).toHaveBeenLastCalledWith(USER_A, { ...original, hotMemoryText: 'new post-pivot memory' });
    expect(JSON.parse(await readFile(join(root, LEGACY_MEMORY_BACKUP_FILE), 'utf8'))).toEqual(original);
  });

  it('preserves files and marker after a database failure, then retries from the original snapshot after restart', async () => {
    const { home, root } = await fixture();
    const repo = repository();
    repo.reconcileRuntimeArtifacts.mockRejectedValueOnce(new Error('database unavailable'));
    const inner = runtime();
    const makeRuntime = () => new MemoryAgentRuntime(inner, new MemoryService(repo as unknown as MemoryRepository), new MemoryMaterializer(home));
    await expect(makeRuntime().submit(owned, 'hello', { context })).rejects.toThrow('database unavailable');
    expect(inner.submit).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'memories', 'MEMORY.md'), 'utf8')).toBe(original.hotMemoryText);
    expect(await readdir(root)).toContain(LEGACY_CLAW_MARKER_FILE);
    expect(await readdir(root)).not.toContain(MEMORY_MARKER_FILE);
    // Also simulates interrupted materialization before the new marker is committed.
    await writeFile(join(root, 'SOUL.md'), 'partial write');
    await makeRuntime().submit(owned, 'retry', { context });
    expect(await readFile(join(root, 'SOUL.md'), 'utf8')).toBe(original.soulText);
    expect(await readFile(join(root, 'memories', 'MEMORY.md'), 'utf8')).toBe(original.hotMemoryText);
  });

  it('rejects foreign ownership before reading or reconciling private artifacts', async () => {
    const { home, root } = await fixture();
    const repo = repository();
    const agent = new MemoryAgentRuntime(runtime(), new MemoryService(repo as unknown as MemoryRepository), new MemoryMaterializer(home));
    await expect(agent.submit(owned, 'hello', { context: { ...context, userId: USER_B } })).rejects.toThrow('ownership');
    await expect(agent.reconcile(owned, { ...context, userId: USER_B })).rejects.toThrow('ownership');
    expect(repo.reconcileRuntimeArtifacts).not.toHaveBeenCalled();
    expect(await readdir(root)).not.toContain(LEGACY_MEMORY_BACKUP_FILE);
  });

  it('refuses direct stale materialization and unreadable or malformed migration inputs', async () => {
    const { home, root } = await fixture();
    const materializer = new MemoryMaterializer(home);
    await expect(materializer.materialize(owned, original, 'new')).rejects.toThrow('must be reconciled');
    await writeFile(join(root, LEGACY_CLAW_MARKER_FILE), '');
    await expect(materializer.readCompletedPrivateArtifacts(owned)).rejects.toThrow();
    await expect(materializer.materialize(owned, original, 'new')).rejects.toThrow();
    await writeFile(join(root, LEGACY_CLAW_MARKER_FILE), '{"runtimeHash":"old"}');
    await rm(join(root, 'memories', 'USER.md'));
    await expect(materializer.readCompletedPrivateArtifacts(owned)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).not.toContain(LEGACY_MEMORY_BACKUP_FILE);
    await writeFile(join(root, LEGACY_MEMORY_BACKUP_FILE), '{broken');
    await expect(materializer.readCompletedPrivateArtifacts(owned)).rejects.toThrow();
    expect(await readFile(join(root, 'memories', 'MEMORY.md'), 'utf8')).toBe(original.hotMemoryText);
  });

  it('unlinks a symlinked mount without traversing it', async () => {
    const { home, root, mount } = await fixture();
    await removeLegacySharedSkills(root);
    const outside = join(home, 'outside');
    await mkdir(outside, { mode: 0o500 });
    await symlink(outside, mount);
    await removeLegacySharedSkills(root);
    expect((await lstat(outside)).mode & 0o777).toBe(0o500);
    await chmod(outside, 0o700);
  });
});
