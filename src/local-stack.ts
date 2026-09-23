import type { NetworkInterfaceInfo } from 'node:os';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LocalProfile {
  userId: string;
  profileName: string;
}

export function requestedUserIds(arguments_: string[], configured = '') {
  const fromArguments: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--user-id') {
      const value = arguments_[index + 1];
      if (!value) throw new Error('--user-id requires a Supabase user UUID.');
      fromArguments.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown local stack argument: ${argument}`);
  }

  const candidates = fromArguments.length
    ? fromArguments
    : configured.split(',').map((value) => value.trim()).filter(Boolean);
  const unique = [...new Set(candidates.map((value) => value.toLowerCase()))];
  if (unique.some((value) => !uuidPattern.test(value))) {
    throw new Error('APT_LOCAL_USER_IDS and --user-id values must be valid Supabase user UUIDs.');
  }
  if (unique.length > 10) throw new Error('The local beta stack supports at most 10 users.');
  return unique;
}

export function profileUrlMap(profiles: LocalProfile[], basePort: number) {
  if (!Number.isInteger(basePort) || basePort < 1 || basePort + profiles.length - 1 > 65_535) {
    throw new Error('APT_LOCAL_HERMES_BASE_PORT does not leave enough valid ports for the selected users.');
  }
  const sorted = [...profiles].sort((left, right) => left.profileName.localeCompare(right.profileName));
  return sorted.map((profile, index) => ({
    ...profile,
    port: basePort + index,
    url: `http://127.0.0.1:${basePort + index}`,
  }));
}

export function upsertEnvironment(source: string, updates: Record<string, string>) {
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid environment update for ${key}.`);
    }
  }

  const remaining = new Map(Object.entries(updates));
  const lines = source ? source.replace(/\r\n?/g, '\n').split('\n') : [];
  const result: string[] = [];
  for (const line of lines) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }
    const key = match[1]!;
    if (!(key in updates)) {
      result.push(line);
      continue;
    }
    const value = remaining.get(key);
    if (value === undefined) continue;
    remaining.delete(key);
    result.push(`${key}=${value}`);
  }
  while (result.length && !result.at(-1)) result.pop();
  if (result.length && remaining.size) result.push('');
  for (const [key, value] of remaining) result.push(`${key}=${value}`);
  return `${result.join('\n')}\n`;
}

export function lanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  override?: string,
) {
  if (override) {
    if (!ipv4Pattern(override)) throw new Error('APT_LOCAL_LAN_IP must be an IPv4 address.');
    return override;
  }
  const usable = (entries?: NetworkInterfaceInfo[]) => entries?.find((entry) =>
    entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.') && ipv4Pattern(entry.address),
  )?.address;
  return usable(interfaces.en0)
    ?? Object.values(interfaces).map(usable).find(Boolean)
    ?? (() => { throw new Error('No non-loopback IPv4 address was found. Set APT_LOCAL_LAN_IP explicitly.'); })();
}

function ipv4Pattern(value: string) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Resolve an explicit API origin before attempting LAN interface discovery. */
export function mobileApiUrl(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port: number, override?: string, lanOverride?: string) {
  if (override === undefined) return `http://${lanAddress(interfaces, lanOverride)}:${port}`;
  if (!/^https?:\/\//.test(override) || override !== override.trim() || /[\r\n]/.test(override) || !URL.canParse(override)) {
    throw new Error('APT_MOBILE_API_URL must be an absolute HTTP(S) URL.');
  }
  const url = new URL(override);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('APT_MOBILE_API_URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  const host = url.hostname;
  const parts = host.split('.').map(Number);
  const privateIp = ipv4Pattern(host) && (parts[0] === 10 || parts[0] === 127
    || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127));
  if (url.protocol === 'http:' && !privateIp && host !== 'localhost' && host !== '[::1]') {
    throw new Error('APT_MOBILE_API_URL requires HTTPS for remote hosts; iOS blocks remote cleartext HTTP.');
  }
  return url.origin;
}
