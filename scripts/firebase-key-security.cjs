const path = require('node:path');
const { firebaseConfig } = require('../shared/firebase-config');
async function main() {
  const cli = process.argv[2];
  if (!cli) throw new Error('Pass the path to firebase.cmd.');
  const auth = require(path.join(path.dirname(cli), 'node_modules/firebase-tools/lib/auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI is not signed in.');
  const credentials = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  async function request(url, method = 'GET', body) {
    const response = await fetch(url, { method,
      headers: { Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`API key settings request returned HTTP ${response.status}.`);
    return response.json();
  }
  const lookup = await request(`https://apikeys.googleapis.com/v2/keys:lookupKey?keyString=${encodeURIComponent(firebaseConfig.apiKey)}`);
  const url = `https://apikeys.googleapis.com/v2/${lookup.name}`;
  let key = await request(url);
  const servicesBefore = (key.restrictions?.apiTargets || []).map((item) => item.service).sort();
  if (process.argv.includes('--apply')) {
    let operation = await request(`${url}?updateMask=restrictions`, 'PATCH', {
      name: key.name, etag: key.etag,
      restrictions: { ...key.restrictions, apiTargets: [
        { service: 'identitytoolkit.googleapis.com' }, { service: 'securetoken.googleapis.com' }
      ] }
    });
    for (let i = 0; !operation.done && i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      operation = await request(`https://apikeys.googleapis.com/v2/${operation.name}`);
    }
    if (!operation.done || operation.error) throw new Error('API key restriction update did not complete successfully.');
    key = await request(url);
  }
  console.log(JSON.stringify({ applied: process.argv.includes('--apply'), servicesBefore,
    allowedServices: (key.restrictions?.apiTargets || []).map((item) => item.service).sort() }));
  const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `security-probe-${Date.now()}@example.com`, password: 'not-an-account-password', returnSecureToken: true }),
    signal: AbortSignal.timeout(20000)
  });
  const signInError = (await signIn.json()).error?.message || '';
  if (signIn.status !== 400 || !['INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND'].includes(signInError)) {
    throw new Error('Authentication API key restriction check failed.');
  }
  const refresh = await fetch(`https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=invalid-security-test-token', signal: AbortSignal.timeout(20000)
  });
  const refreshError = (await refresh.json()).error?.message || '';
  if (refresh.status !== 400 || /API_KEY|KEY_INVALID|BLOCKED/.test(refreshError)) {
    throw new Error('Secure Token API key restriction check failed.');
  }
  console.log(JSON.stringify({ authenticationServiceReachable: true, tokenServiceReachable: true }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
