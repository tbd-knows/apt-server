import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { SupabaseAuthService } from '../src/auth.js';

/** Optional real Auth boundary for the disposable local Hermes harness.
 * Never creates sessions for existing founders or changes the live allowlist. */
export async function testAccountAuth(path: string) {
  assert.equal((await stat(path)).mode & 0o077, 0, 'Test account manifest must be owner-readable only.');
  const manifest = z.object({
    project: z.string().regex(/^[a-z]{20}$/), runId: z.uuid(), publishableKey: z.string().min(20),
    accounts: z.array(z.object({ role: z.enum(['buyer', 'seller']), id: z.uuid(),
      email: z.email(), password: z.string().min(40) })).length(2),
  }).parse(JSON.parse(await readFile(path, 'utf8')));
  assert.deepEqual(manifest.accounts.map(a => a.role), ['buyer', 'seller']);
  assert.notEqual(manifest.accounts[0]!.id, manifest.accounts[1]!.id);
  const url = `https://${manifest.project}.supabase.co`;
  const sessions: { token: string; close: () => Promise<void> }[] = [];
  try {
    for (const account of manifest.accounts) {
      assert.equal(account.email, `tbd12-${manifest.runId}-${account.role}@example.invalid`);
      const client = createClient(url, manifest.publishableKey, { auth: {
        autoRefreshToken: false, persistSession: false, detectSessionInUrl: false,
      } });
      const { data, error } = await client.auth.signInWithPassword({ email: account.email, password: account.password });
      assert(!error && data.session, 'Dedicated test account sign-in failed.');
      sessions.push({ token: data.session.access_token, close: async () => {
        const result = await client.auth.signOut({ scope: 'local' });
        assert(!result.error, `Test session sign-out failed (${result.error?.status ?? 'unknown'}/${result.error?.code ?? 'unknown'}).`);
      } });
      assert.equal(data.user.id, account.id);
      assert.equal(data.user.app_metadata.tbd_test_run, manifest.runId, 'Refusing a non-test identity.');
      assert.equal(data.user.app_metadata.tbd_test_role, account.role);
    }
  } catch (error) {
    await Promise.allSettled(sessions.map(s => s.close()));
    throw error;
  }
  return { url, publishableKey: manifest.publishableKey, actors: manifest.accounts.map(a => a.id),
    auth: SupabaseAuthService.create(url, manifest.publishableKey), tokens: sessions.map(s => s.token),
    close: async () => { await Promise.all(sessions.map(s => s.close())); },
  };
}
