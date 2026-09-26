import { createHmac, timingSafeEqual } from 'node:crypto';

export function a2aBridgeToken(profile: string, secret: string) {
  return `${profile}.${createHmac('sha256', secret).update(`tbd-a2a-bridge:${profile}`).digest('base64url')}`;
}
export function verifyA2ABridgeToken(token: string, secret: string) {
  const profile = token.split('.')[0] ?? '';
  if (!/^apt-[a-f0-9]{20}$/.test(profile)) return null;
  const expected = Buffer.from(a2aBridgeToken(profile, secret));
  const received = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(expected, received) ? profile : null;
}
export function a2aPeerToken(sender: string, recipient: string, secret: string) {
  return createHmac('sha256', secret).update(`tbd-a2a-peer:${sender}:${recipient}`).digest('base64url');
}
