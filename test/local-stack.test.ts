import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { lanAddress, mobileApiUrl, profileUrlMap, requestedUserIds, upsertEnvironment } from '../src/local-stack.js';

describe('local phone stack configuration', () => {
  it('uses a stable HTTPS API without LAN discovery and preserves it during env rewrites', () => {
    const url = mobileApiUrl({}, 8787, 'https://pilot.example.com/');
    expect(url).toBe('https://pilot.example.com');
    const env = upsertEnvironment('', { EXPO_PUBLIC_APT_API_URL: url });
    expect(upsertEnvironment(env, { EXPO_PUBLIC_APT_API_URL: url })).toBe(env);
    expect(mobileApiUrl({}, 8787, 'http://100.64.1.2:8787')).toBe('http://100.64.1.2:8787');
    expect(mobileApiUrl({}, 8787, undefined, '192.168.1.10')).toBe('http://192.168.1.10:8787');
  });
  it.each(['', '/relative', 'ftp://example.com', 'http://example.com', 'http://192.168.1.2.evil.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?secret=x'])('rejects invalid or unsafe API origin %s', url => {
    expect(() => mobileApiUrl({}, 8787, url)).toThrow('APT_MOBILE_API_URL');
  });
  it('accepts repeated CLI users ahead of configured defaults', () => {
    expect(requestedUserIds([
      '--user-id', '22f2cd36-a208-494d-abd8-35fe7bccf8c2',
      '--user-id', 'DB7007E8-A7AD-46E5-A5B9-1F24A2B75960',
    ], '00000000-0000-4000-8000-000000000000')).toEqual([
      '22f2cd36-a208-494d-abd8-35fe7bccf8c2',
      'db7007e8-a7ad-46e5-a5b9-1f24a2b75960',
    ]);
  });

  it('rejects malformed user IDs and unknown arguments', () => {
    expect(() => requestedUserIds([], 'not-a-uuid')).toThrow('valid Supabase user UUIDs');
    expect(() => requestedUserIds(['--all'])).toThrow('Unknown local stack argument');
  });

  it('assigns stable ports by opaque profile name', () => {
    expect(profileUrlMap([
      { userId: 'b', profileName: 'apt-bbbbbbbbbbbbbbbbbbbb' },
      { userId: 'a', profileName: 'apt-aaaaaaaaaaaaaaaaaaaa' },
    ], 8642)).toEqual([
      { userId: 'a', profileName: 'apt-aaaaaaaaaaaaaaaaaaaa', port: 8642, url: 'http://127.0.0.1:8642' },
      { userId: 'b', profileName: 'apt-bbbbbbbbbbbbbbbbbbbb', port: 8643, url: 'http://127.0.0.1:8643' },
    ]);
  });

  it('updates the ignored Expo environment without dropping unrelated values', () => {
    expect(upsertEnvironment('KEEP_ME=yes\nEXPO_PUBLIC_APT_API_URL=http://old\nEXPO_PUBLIC_APT_API_URL=http://duplicate\n', {
      EXPO_PUBLIC_APT_API_URL: 'http://192.168.1.4:8787',
      EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    })).toBe([
      'KEEP_ME=yes',
      'EXPO_PUBLIC_APT_API_URL=http://192.168.1.4:8787',
      '',
      'EXPO_PUBLIC_SUPABASE_URL=https://example.supabase.co',
      '',
    ].join('\n'));
  });

  it('prefers en0 and supports an explicit LAN override', () => {
    const entry = (address: string): NetworkInterfaceInfo => ({
      address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/24`,
    });
    expect(lanAddress({ en7: [entry('10.0.0.2')], en0: [entry('192.168.1.11')] })).toBe('192.168.1.11');
    expect(lanAddress({}, '172.16.0.4')).toBe('172.16.0.4');
  });
});
