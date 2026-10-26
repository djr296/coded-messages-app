const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { privacyPlan } = require('../shared/privacy-migration');
const project = 'coded-messages';
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const args = process.argv.slice(2);
const cliPath = args[args.indexOf('--firebase-cli') + 1];
app.whenReady().then(async () => {
  if (!args.includes('--firebase-cli') || !cliPath) throw new Error('Pass --firebase-cli with the path to firebase.cmd.');
  const auth = require(path.join(path.dirname(cliPath), 'node_modules/firebase-tools/lib/auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI is not signed in.');
  const credentials = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/firebase']);
  async function request(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Migration request failed with HTTP ${response.status}; no credentials or account records are logged.`);
    return response.json();
  }
  async function list(collection) {
    const documents = [];
    let token = '';
    do {
      const result = await request(`${base}/${collection}?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      documents.push(...(result.documents || []));
      token = result.nextPageToken || '';
    } while (token);
    return documents;
  }
  const [users, privateRecords, reservations] = await Promise.all([list('users'), list('privateUsers'), list('usernames')]);
  const plan = privacyPlan(users, privateRecords, reservations);
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ mode: 'inspection-only', ...plan.summary }));
    app.exit(0);
    return;
  }
  const release = await request(`https://firebaserules.googleapis.com/v1/projects/${project}/releases/cloud.firestore`);
  const ruleset = await request(`https://firebaserules.googleapis.com/v1/${release.rulesetName}`);
  const source = ruleset.source.files.map((file) => file.content).join('\n').replace(/\r\n/g, '\n').trim();
  if (source !== fs.readFileSync('firestore.rules', 'utf8').replace(/\r\n/g, '\n').trim()) {
    throw new Error('Deploy the reviewed privacy rules before applying the data migration.');
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows-protected backup encryption is unavailable. Migration cancelled.');
  const serialized = JSON.stringify({ project, createdAt: new Date().toISOString(), users, privateRecords, reservations });
  const encrypted = safeStorage.encryptString(serialized);
  if (safeStorage.decryptString(encrypted) !== serialized) throw new Error('Backup encryption check failed.');
  const backupPath = `data/privacy-backup-${Date.now()}.bin`;
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(backupPath, encrypted, { mode: 0o600 });
  let applied = 0;
  for (let offset = 0; offset < plan.writes.length; offset += 400) {
    await request(`${base}:commit`, 'POST', { writes: plan.writes.slice(offset, offset + 400) });
    applied += Math.min(400, plan.writes.length - offset);
  }
  const [after, names] = await Promise.all([list('users'), list('usernames')]);
  const publicEmailFields = after.filter((doc) => Object.hasOwn(doc.fields || {}, 'email')).length;
  const mapping = new Map(names.map((doc) => [doc.name.split('/').pop(), doc.fields.uid?.stringValue]));
  const inconsistentNames = after.filter((doc) => mapping.get(doc.fields.username_lower?.stringValue) !== doc.name.split('/').pop()).length;
  if (publicEmailFields || inconsistentNames) throw new Error('Post-migration verification failed; encrypted backup is retained.');
  console.log(JSON.stringify({ mode: 'applied', ...plan.summary, appliedWrites: applied, backupPath, publicEmailFields, inconsistentNames }));
  app.exit(0);
}).catch((error) => { console.error(error.message); app.exit(1); });
