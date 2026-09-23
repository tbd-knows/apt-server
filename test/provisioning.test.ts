import { describe, expect, it, vi } from 'vitest';
import {
  DISABLED_HERMES_TOOLSETS,
  LEGACY_BROWSER_POLICY_PLUGIN,
  LEGACY_PROFILE_SECRETS,
  profileIdentity,
  ProvisioningService,
  REQUIRED_HERMES_TOOLSETS,
  type HermesProfileAdmin,
} from '../src/admin/service.js';
import { MEMORY_TOOL_NAMES } from '../src/memory/domain.js';
import { instance, repository, USER_A } from './fixtures.js';

function hermes(exists = false): HermesProfileAdmin {
  return {
    exists: vi.fn(async () => exists),
    create: vi.fn(async () => undefined),
    configure: vi.fn(async () => undefined),
    validate: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe('manual provisioning lifecycle', () => {
  it('exposes only memory and session search, and disables every retired toolset', () => {
    expect([...REQUIRED_HERMES_TOOLSETS]).toEqual(['memory', 'session_search']);
    for (const retired of ['browser', 'skills', 'web', 'search', 'terminal', 'file', 'code_execution', 'delegation', 'cronjob', 'computer_use']) {
      expect(DISABLED_HERMES_TOOLSETS).toContain(retired);
    }
    expect(REQUIRED_HERMES_TOOLSETS.some((toolset) => (DISABLED_HERMES_TOOLSETS as readonly string[]).includes(toolset))).toBe(false);
    expect([...MEMORY_TOOL_NAMES]).toEqual(['apt_search_knowledge', 'apt_remember', 'apt_update_private_artifact']);
    expect(LEGACY_BROWSER_POLICY_PLUGIN).toBe('apt-hunt-browser-policy');
    expect(LEGACY_PROFILE_SECRETS).toContain('AGENT_BROWSER_EXECUTABLE_PATH');
  });

  it('derives stable opaque profile and session identifiers', () => {
    const first = profileIdentity(USER_A, 's'.repeat(32));
    expect(first).toEqual(profileIdentity(USER_A, 's'.repeat(32)));
    expect(first.profileName).not.toContain(USER_A);
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates an Apt-only profile and validates its narrow capability set', async () => {
    const repo = repository({ getAgentInstance: vi.fn(async () => null) });
    const profiles = hermes(false);
    const service = new ProvisioningService(repo, { requireUser: vi.fn(async () => undefined) }, profiles, 's'.repeat(32));
    await service.provision(USER_A);
    expect(profiles.create).toHaveBeenCalledOnce();
    expect(profiles.configure).toHaveBeenCalledOnce();
    expect(profiles.validate).toHaveBeenCalledOnce();
    expect(repo.upsertAgentInstance).toHaveBeenCalledOnce();
  });

  it('reconfigures an existing mapping idempotently without recreating it', async () => {
    const identity = profileIdentity(USER_A, 's'.repeat(32));
    const existing = { ...instance, hermesProfileName: identity.profileName, hermesSessionId: identity.sessionId };
    const repo = repository({ getAgentInstance: vi.fn(async () => existing) });
    const profiles = hermes(true);
    const service = new ProvisioningService(repo, { requireUser: vi.fn(async () => undefined) }, profiles, 's'.repeat(32));
    await expect(service.provision(USER_A)).resolves.toEqual(existing);
    expect(profiles.create).not.toHaveBeenCalled();
    expect(profiles.configure).toHaveBeenCalledOnce();
    expect(profiles.validate).toHaveBeenCalledOnce();
    expect(repo.upsertAgentInstance).not.toHaveBeenCalled();
  });

  it('requires exact confirmation and deletes Hermes before database records', async () => {
    const order: string[] = [];
    const repo = repository({ getAgentInstance: vi.fn(async () => instance), deleteUserRecords: vi.fn(async () => { order.push('database'); }) });
    const profiles = hermes(true);
    vi.mocked(profiles.delete).mockImplementation(async () => { order.push('hermes'); });
    const service = new ProvisioningService(repo, { requireUser: vi.fn(async () => undefined) }, profiles, 's'.repeat(32));
    await expect(service.delete(USER_A, 'wrong')).rejects.toThrow('exactly match');
    await service.delete(USER_A, USER_A);
    expect(order).toEqual(['hermes', 'database']);
  });
});
