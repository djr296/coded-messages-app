const fs = require('node:fs');
const path = require('node:path');
async function main() {
  const cli = process.argv[2];
  if (!cli) throw new Error('Pass the path to firebase.cmd.');
  const auth = require(path.join(path.dirname(cli), 'node_modules/firebase-tools/lib/auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI is not signed in.');
  const credentials = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const url = 'https://identitytoolkit.googleapis.com/admin/v2/projects/coded-messages/config';
  async function request(method, body) {
    const response = await fetch(url + (body ? '?updateMask=emailPrivacyConfig,passwordPolicyConfig' : ''), {
      method, headers: { Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(`Firebase Auth configuration returned HTTP ${response.status}: ${payload.error?.message || 'Request failed'}`);
    }
    return response.json();
  }
  const before = await request('GET');
  let result = before;
  if (process.argv.includes('--apply')) {
    const policy = before.passwordPolicyConfig || {};
    const strength = policy.passwordPolicyVersions?.[0]?.customStrengthOptions || {};
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync('data/auth-security-settings-before.json', JSON.stringify({
      emailPrivacyConfig: before.emailPrivacyConfig, passwordPolicyConfig: before.passwordPolicyConfig
    }, null, 2));
    result = await request('PATCH', {
      emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
      passwordPolicyConfig: {
        passwordPolicyEnforcementState: 'ENFORCE', forceUpgradeOnSignin: false,
        passwordPolicyVersions: [{ customStrengthOptions: { ...strength, minPasswordLength: Math.max(12, strength.minPasswordLength || 0) } }]
      }
    });
  }
  console.log(JSON.stringify({ applied: process.argv.includes('--apply'),
    emailEnumerationProtection: result.emailPrivacyConfig?.enableImprovedEmailPrivacy || false,
    passwordPolicyState: result.passwordPolicyConfig?.passwordPolicyEnforcementState || 'OFF',
    minimumNewPasswordLength: result.passwordPolicyConfig?.passwordPolicyVersions?.[0]?.customStrengthOptions?.minPasswordLength || 6,
    forceExistingPasswordUpgrade: result.passwordPolicyConfig?.forceUpgradeOnSignin || false
  }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
