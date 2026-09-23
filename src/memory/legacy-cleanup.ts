import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const LEGACY_SHARED_SKILLS_DIRECTORY = 'apt-shared-skills';

/** Retire only this profile's generated mount; never follow skill symlinks. */
export async function removeLegacySharedSkills(profileRoot: string) {
  const profile = await lstat(profileRoot);
  if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error('Refusing a symlinked Hermes profile.');
  const mount = join(profileRoot, LEGACY_SHARED_SKILLS_DIRECTORY);
  await makeDirectoriesWritable(mount);
  await rm(mount, { recursive: true, force: true });
}

async function makeDirectoriesWritable(path: string): Promise<void> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry?.isDirectory() || entry.isSymbolicLink()) return;
  // The old materializer used 0500 directories. Unlinking their children
  // requires owner write permission, including on the mount itself.
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await makeDirectoriesWritable(join(path, name));
}
