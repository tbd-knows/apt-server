import { describe, expect, it } from 'vitest';
import { a2aBridgeToken, a2aPeerToken, verifyA2ABridgeToken } from '../src/commerce/a2a-auth.js';
import { aptBridgeToken, verifyAptBridgeToken } from '../src/memory/bridge-auth.js';

describe('Hermes A2A authority', () => {
  const a = 'apt-aaaaaaaaaaaaaaaaaaaa'; const b = 'apt-bbbbbbbbbbbbbbbbbbbb'; const secret = 's'.repeat(32);
  it('does not let transport credentials invoke private model tools or vice versa', () => {
    expect(verifyA2ABridgeToken(a2aBridgeToken(a, secret), secret)).toBe(a);
    expect(verifyAptBridgeToken(a2aBridgeToken(a, secret), secret)).toBeNull();
    expect(verifyA2ABridgeToken(aptBridgeToken(a, secret), secret)).toBeNull();
    expect(verifyA2ABridgeToken(a2aBridgeToken(a, secret), 'x'.repeat(32))).toBeNull();
    expect(verifyA2ABridgeToken(a2aBridgeToken(a, secret).replace(a, b), secret)).toBeNull();
  });
  it('binds tokens to one sender and recipient direction', () => {
    expect(a2aPeerToken(a, b, secret)).not.toBe(a2aPeerToken(b, a, secret));
    expect(a2aPeerToken(a, b, secret)).not.toBe(a2aPeerToken(a, a, secret));
  });
});
