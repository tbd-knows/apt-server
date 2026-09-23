import { createHmac, timingSafeEqual } from 'node:crypto';

export function aptBridgeToken(profileName: string, secret: string) {
  const signature = createHmac('sha256', secret).update(`apt-claw-bridge:${profileName}`).digest('base64url');
  return `${profileName}.${signature}`;
}

export function verifyAptBridgeToken(token: string, secret: string) {
  const separator = token.indexOf('.');
  if (separator <= 0) return null;
  const profileName = token.slice(0, separator);
  if (!/^apt-[a-f0-9]{20}$/.test(profileName)) return null;
  const expected = Buffer.from(aptBridgeToken(profileName, secret));
  const provided = Buffer.from(token);
  return expected.length === provided.length && timingSafeEqual(expected, provided) ? profileName : null;
}

