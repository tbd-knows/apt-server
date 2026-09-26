import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const required = {
  APT_PILOT_USER_IDS: '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-tests',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  SUPABASE_DATABASE_URL: 'postgresql://example',
  HERMES_KEY_SECRET: 'x'.repeat(32),
  HERMES_MODEL: 'test-model',
  HERMES_PROVIDER_API_KEY: 'test-key',
};

describe('Hermes provider configuration', () => {
  it('pins A2A destinations to HTTP origins without embedded secrets', () => {
    const profile = 'apt-aaaaaaaaaaaaaaaaaaaa';
    for (const url of ['file:///tmp/peer', 'https://user:secret@peer', 'https://peer/?token=secret', 'https://peer/alternate', 'https://peer/#fragment']) {
      expect(() => loadConfig({ ...required, HERMES_A2A_PROFILE_URL_MAP: JSON.stringify({ [profile]: url }) })).toThrow();
    }
    expect(() => loadConfig({ ...required, HERMES_A2A_PROFILE_URL_TEMPLATE: 'http://peer:9900' })).toThrow();
    expect(loadConfig({ ...required, HERMES_A2A_PROFILE_URL_MAP: JSON.stringify({ [profile]: 'http://127.0.0.1:9900' }) }).hermes.a2aProfileUrls[profile]).toBe('http://127.0.0.1:9900');
  });
  it('defaults to the direct OpenAI API provider', () => {
    expect(loadConfig(required).hermes.provider).toBe('openai-api');
  });

  it('requires an explicit endpoint for the custom provider', () => {
    expect(() => loadConfig({ ...required, HERMES_PROVIDER: 'custom' })).toThrow(
      'HERMES_PROVIDER_BASE_URL is required when HERMES_PROVIDER=custom.',
    );
  });

  it('accepts a custom provider with an explicit endpoint', () => {
    const config = loadConfig({
      ...required,
      HERMES_PROVIDER: 'custom',
      HERMES_PROVIDER_BASE_URL: 'http://127.0.0.1:9999/v1',
    });
    expect(config.hermes.providerBaseUrl).toBe('http://127.0.0.1:9999/v1');
  });
});
