import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentInstance } from '../domain.js';
import type { RuntimePrivateArtifacts } from './domain.js';
import { removeLegacySharedSkills } from './legacy-cleanup.js';
export { LEGACY_SHARED_SKILLS_DIRECTORY } from './legacy-cleanup.js';

interface RuntimeMarker {
  runtimeHash: string;
}

export const MEMORY_MARKER_FILE = '.apt-memory.json';
/** Retained until private artifacts have been reconciled and materialized. */
export const LEGACY_CLAW_MARKER_FILE = '.apt-claw.json';
export const LEGACY_MEMORY_BACKUP_FILE = '.apt-claw-memory-backup.json';

/**
 * Writes the owner's private Soul/USER/MEMORY artifacts into that owner's
 * isolated Hermes profile before a turn and reads them back afterwards. It
 * never writes skills: retained `private.*` skill directories stay on disk as
 * inert data and the skills toolset is disabled during provisioning.
 */
export class MemoryMaterializer {
  constructor(private readonly hermesHome: string) {}

  private profileDirectory(instance: AgentInstance) {
    if (!/^apt-[a-f0-9]{20}$/.test(instance.hermesProfileName)) throw new Error('Refusing to materialize an invalid Hermes profile name.');
    return join(this.hermesHome, 'profiles', instance.hermesProfileName);
  }

  async readCompletedPrivateArtifacts(instance: AgentInstance): Promise<RuntimePrivateArtifacts | null> {
    const root = this.profileDirectory(instance);
    const marker = await readOptional(join(root, MEMORY_MARKER_FILE));
    if (marker === null) {
      const legacy = await readOptional(join(root, LEGACY_CLAW_MARKER_FILE));
      if (legacy === null) return null;
      parseMarker(legacy);
      const backup = await readOptional(join(root, LEGACY_MEMORY_BACKUP_FILE));
      if (backup !== null) return parseArtifacts(backup);
      // A missing/unreadable legacy artifact must stop migration, not turn
      // into an empty value that could erase the owner's database memory.
      const artifacts = {
        soulText: await readFile(join(root, 'SOUL.md'), 'utf8'),
        hotUserText: await readFile(join(root, 'memories', 'USER.md'), 'utf8'),
        hotMemoryText: await readFile(join(root, 'memories', 'MEMORY.md'), 'utf8'),
      };
      await atomicWrite(join(root, LEGACY_MEMORY_BACKUP_FILE), JSON.stringify(artifacts), 0o600);
      return artifacts;
    }
    parseMarker(marker);
    return {
      soulText: (await readOptional(join(root, 'SOUL.md'))) ?? '',
      hotUserText: (await readOptional(join(root, 'memories', 'USER.md'))) ?? '',
      hotMemoryText: (await readOptional(join(root, 'memories', 'MEMORY.md'))) ?? '',
    };
  }

  async materialize(instance: AgentInstance, artifacts: RuntimePrivateArtifacts, runtimeHash: string) {
    const root = this.profileDirectory(instance);
    await mkdir(join(root, 'memories'), { recursive: true, mode: 0o700 });
    const currentMarker = await readOptional(join(root, MEMORY_MARKER_FILE));
    const legacyMarker = await readOptional(join(root, LEGACY_CLAW_MARKER_FILE));
    if (legacyMarker !== null && currentMarker === null) {
      parseMarker(legacyMarker);
      const backup = await readOptional(join(root, LEGACY_MEMORY_BACKUP_FILE));
      const saved = backup === null ? null : parseArtifacts(backup);
      if (!saved || saved.soulText !== artifacts.soulText || saved.hotUserText !== artifacts.hotUserText || saved.hotMemoryText !== artifacts.hotMemoryText) {
        throw new Error('Legacy private memory must be reconciled before materialization.');
      }
    }
    await removeLegacySharedSkills(root);
    if (currentMarker !== null) {
      if (parseMarker(currentMarker).runtimeHash === runtimeHash) {
        await rm(join(root, LEGACY_CLAW_MARKER_FILE), { force: true });
        return false;
      }
    }
    await atomicWrite(join(root, 'SOUL.md'), artifacts.soulText, 0o600);
    await atomicWrite(join(root, 'memories', 'USER.md'), artifacts.hotUserText, 0o600);
    await atomicWrite(join(root, 'memories', 'MEMORY.md'), artifacts.hotMemoryText, 0o600);
    await atomicWrite(join(root, MEMORY_MARKER_FILE), JSON.stringify({ runtimeHash }), 0o600);
    await rm(join(root, LEGACY_CLAW_MARKER_FILE), { force: true });
    return true;
  }
}

async function readOptional(path: string) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseMarker(text: string): RuntimeMarker {
  const marker = JSON.parse(text) as RuntimeMarker | null;
  if (!marker || typeof marker.runtimeHash !== 'string') throw new Error('Invalid private memory marker.');
  return marker;
}

function parseArtifacts(text: string): RuntimePrivateArtifacts {
  const value = JSON.parse(text) as RuntimePrivateArtifacts | null;
  if (!value || typeof value.soulText !== 'string' || typeof value.hotUserText !== 'string' || typeof value.hotMemoryText !== 'string') {
    throw new Error('Invalid legacy private memory backup; preserve it for recovery.');
  }
  return { soulText: value.soulText, hotUserText: value.hotUserText, hotMemoryText: value.hotMemoryText };
}

async function atomicWrite(path: string, content: string, mode: number) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}
