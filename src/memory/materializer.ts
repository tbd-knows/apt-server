import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentInstance } from '../domain.js';
import type { RuntimePrivateArtifacts } from './domain.js';

interface RuntimeMarker {
  runtimeHash: string;
}

export const MEMORY_MARKER_FILE = '.apt-memory.json';
/** Marker written by the retired Claw runtime; removed on first materialization. */
export const LEGACY_CLAW_MARKER_FILE = '.apt-claw.json';
/** Read-only shared skill mount written by the retired Claw runtime. */
export const LEGACY_SHARED_SKILLS_DIRECTORY = 'apt-shared-skills';

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
    if (!marker) return null;
    try { JSON.parse(marker) as RuntimeMarker; } catch { return null; }
    return {
      soulText: (await readOptional(join(root, 'SOUL.md'))) ?? '',
      hotUserText: (await readOptional(join(root, 'memories', 'USER.md'))) ?? '',
      hotMemoryText: (await readOptional(join(root, 'memories', 'MEMORY.md'))) ?? '',
    };
  }

  async materialize(instance: AgentInstance, artifacts: RuntimePrivateArtifacts, runtimeHash: string) {
    const root = this.profileDirectory(instance);
    await mkdir(join(root, 'memories'), { recursive: true, mode: 0o700 });
    await rm(join(root, LEGACY_CLAW_MARKER_FILE), { force: true });
    await rm(join(root, LEGACY_SHARED_SKILLS_DIRECTORY), { recursive: true, force: true });
    const currentMarker = await readOptional(join(root, MEMORY_MARKER_FILE));
    if (currentMarker) {
      try {
        if ((JSON.parse(currentMarker) as RuntimeMarker).runtimeHash === runtimeHash) return false;
      } catch { /* replace invalid marker */ }
    }
    await atomicWrite(join(root, 'SOUL.md'), artifacts.soulText, 0o600);
    await atomicWrite(join(root, 'memories', 'USER.md'), artifacts.hotUserText, 0o600);
    await atomicWrite(join(root, 'memories', 'MEMORY.md'), artifacts.hotMemoryText, 0o600);
    await atomicWrite(join(root, MEMORY_MARKER_FILE), JSON.stringify({ runtimeHash }), 0o600);
    return true;
  }
}

async function readOptional(path: string) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

async function atomicWrite(path: string, content: string, mode: number) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${process.pid}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}
