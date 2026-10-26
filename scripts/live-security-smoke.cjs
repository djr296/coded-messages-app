const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { firebaseConfig } = require('../shared/firebase-config');
const project = firebaseConfig.projectId;
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
const authBase = 'https://identitytoolkit.googleapis.com/v1';
const accounts = [];
const documents = new Set();
const realFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
async function trackedFetch(url, options = {}) {
  if (!String(url).startsWith(base) && !String(url).startsWith(authBase)) throw new Error('Unexpected smoke-test destination.');
  const response = await realFetch(url, options);
  if (response.ok && String(url).includes('accounts:signUp')) {
    const body = await response.clone().json();
    accounts.push({ uid: body.localId, idToken: body.idToken });
  }
  if (response.ok && String(url).startsWith(base)) {
    if (String(url).includes(':commit')) {
      for (const write of JSON.parse(options.body || '{}').writes || []) {
        if (write.update) documents.add(write.update.name.split('/documents/')[1]);
      }
    } else if (options.method === 'PATCH') {
      documents.add(decodeURIComponent(new URL(url).pathname.split('/documents/')[1]));
    }
  }
  return response;
}
function client() {
  let api;
  const sourceRequire = createRequire(path.resolve('preload.js'));
  const context = vm.createContext({
    URLSearchParams, console, AbortSignal, btoa, atob, TextEncoder, TextDecoder, Uint8Array, crypto: crypto.webcrypto,
    fetch: trackedFetch,
    require: (name) => name === 'electron'
      ? { contextBridge: { exposeInMainWorld: (key, value) => { if (key === 'codedApi') api = value; } }, ipcRenderer: { invoke: async () => null } }
      : sourceRequire(name)
  });
  vm.runInContext(fs.readFileSync('preload.js', 'utf8'), context);
  return api;
}
async function main() {
  if (!process.argv[2]) throw new Error('Pass firebase.cmd path for cleaning up the temporary test records.');
  const auth = require(path.join(path.dirname(process.argv[2]), 'node_modules/firebase-tools/lib/auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI is not signed in.');
  const admin = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  let completed = false;
  let cleanupFailures = 0;
  try {
    const users = [];
    for (let i = 0; i < 3; i++) {
      const suffix = crypto.randomBytes(8).toString('hex');
      const api = client();
      const credentials = { email: `cm-security-${suffix}@example.com`, username: `sec_${suffix}`, password: crypto.randomBytes(24).toString('base64url') };
      const result = await api.register(credentials);
      users.push({ api, credentials, ...result });
    }
    const [a, b, c] = users;
    await a.api.sendFriendRequest(a.token, b.credentials.username);
    await b.api.acceptFriendRequest(b.token, (await b.api.getFriendRequests(b.token)).requests[0].id);
    const conversationId = (await a.api.getFriends(a.token)).friends[0].conversation_id;
    await a.api.sendMessage(a.token, conversationId, 'Security smoke: plain', 'plain');
    await b.api.sendMessage(b.token, conversationId, 'Security smoke: coded', 'coded');
    assert.equal((await b.api.getMessages(b.token, conversationId)).messages.length, 2);
    const groupId = (await a.api.createGroupConversation(a.token, 'Temporary security test', [b.user.id])).conversation_id;
    const invite = await a.api.createGroupInvite(a.token, groupId, 'never');
    await c.api.joinGroupInvite(c.token, invite.token);
    await c.api.sendMessage(c.token, groupId, 'Temporary test', 'plain');
    await a.api.revokeGroupInvites(a.token, groupId);
    await c.api.leaveConversation(c.token, groupId);
    await assert.rejects(c.api.joinGroupInvite(c.token, invite.token));
    await assert.rejects(c.api.getMessages(c.token, groupId));
    const bSession = JSON.parse(Buffer.from(b.token, 'base64url').toString('utf8'));
    const headers = { Authorization: `Bearer ${bSession.idToken}` };
    const publicProfile = await realFetch(`${base}/users/${a.user.id}`, { headers });
    assert.equal(publicProfile.status, 200);
    assert.equal(Object.hasOwn((await publicProfile.json()).fields, 'email'), false);
    const privateProfile = await realFetch(`${base}/privateUsers/${a.user.id}`, { headers });
    assert.equal(privateProfile.status, 403);
    await a.api.login({ email: a.credentials.email, password: a.credentials.password });
    completed = true;
  } finally {
    for (const doc of [...documents].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const response = await realFetch(`${base}/${doc}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.access_token}` } }).catch(() => null);
      if (!response || (!response.ok && response.status !== 404)) cleanupFailures++;
    }
    for (const user of accounts) {
      const response = await realFetch(`${authBase}/accounts:delete?key=${firebaseConfig.apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: user.idToken })
      }).catch(() => null);
      if (!response || !response.ok) cleanupFailures++;
    }
    console.log(JSON.stringify({ passed: completed, temporaryAccounts: accounts.length, temporaryDocuments: documents.size, cleanupFailures }));
    if (cleanupFailures) throw new Error('Temporary security-test cleanup needs attention.');
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
