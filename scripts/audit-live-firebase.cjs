// Read only: inspect the active ruleset without reading user records or changing Firebase.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function main() {
  if (!process.argv[2]) throw new Error('Pass the path to firebase.cmd.');
  const auth = require(path.join(path.dirname(process.argv[2]), 'node_modules/firebase-tools/lib/auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI is not signed in.');
  const credentials = await auth.getAccessToken(account.tokens.refresh_token, [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/firebase'
  ]);
  async function read(url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${credentials.access_token}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Firebase rules inspection returned HTTP ${response.status}.`);
    return response.json();
  }
  const release = await read('https://firebaserules.googleapis.com/v1/projects/coded-messages/releases/cloud.firestore');
  const ruleset = await read(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`);
  const source = ruleset.source.files.map((file) => file.content).join('\n');
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/security-live.rules', source);
  const normalize = (text) => text.replace(/\r\n/g, '\n').trim();
  const matchesOriginal = normalize(source) === normalize(fs.readFileSync('data/security-original.rules', 'utf8'));
  const matchesLocal = normalize(source) === normalize(fs.readFileSync('firestore.rules', 'utf8'));
  console.log(JSON.stringify({ rulesetName: release.rulesetName, updateTime: release.updateTime,
    matchesOriginal, matchesLocal, sha256: crypto.createHash('sha256').update(source).digest('hex') }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
