function encodeBytes(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeBytes(text) {
  const value = String(text).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(value.padEnd(Math.ceil(value.length / 4) * 4, '=')), (ch) => ch.charCodeAt(0));
}
function encodeSessionToken(state) {
  return encodeBytes(new TextEncoder().encode(JSON.stringify({
    provider: 'firebase', idToken: state.idToken || '', refreshToken: state.refreshToken || '',
    localId: state.localId || '', email: state.email || '', expiresAt: state.expiresAt || 0
  })));
}
function decodeSessionToken(token) {
  if (typeof token !== 'string' || !token || token.length > 32768) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(decodeBytes(token)));
    return session.provider === 'firebase' && session.localId && session.refreshToken ? session : null;
  } catch (_) { return null; }
}
function randomId(bytes = 16) {
  return encodeBytes(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}
module.exports = { encodeSessionToken, decodeSessionToken, randomId };
