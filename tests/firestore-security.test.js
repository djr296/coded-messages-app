const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');

const project = 'demo-coded-messages';
const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8787';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Tests require a local emulator.');
const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const now = new Date().toISOString();
const token = (uid) => [
  { alg: 'none', typ: 'JWT' },
  { sub: uid, user_id: uid, email: `${uid}@example.test`, aud: project,
    iss: `https://securetoken.google.com/${project}`, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, firebase: { sign_in_provider: 'password' } }
].map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.';
function value(item) {
  if (Array.isArray(item)) return { arrayValue: { values: item.map(value) } };
  if (typeof item === 'number') return { integerValue: String(item) };
  return { stringValue: String(item) };
}
async function request(path, uid, data, method = data ? 'PATCH' : 'GET') {
  const category = /^friendRequests\/[^/]+$/.test(path) ? 'social'
    : /^reports\/[^/]+$/.test(path) ? 'reports'
    : /^groupInvites\/[^/]+$/.test(path) && data?.token ? 'invites'
    : /^conversations\/[^/]+$/.test(path) && data?.type ? 'groups'
    : /^conversations\/[^/]+\/messages\/[^/]+$/.test(path) ? 'messages' : '';
  if (uid && uid !== 'owner' && data && method === 'PATCH' && category) {
    const quotaPath = `writeLimits/${uid}/buckets/${category}`;
    const previous = await request(quotaPath, uid);
    const old = previous.body.fields || {};
    const number = (key) => Number(old[key]?.integerValue || -1);
    const minute = Math.floor(Date.now() / 60000);
    const day = Math.floor(Date.now() / 86400000);
    const quota = { window: minute, count: number('window') === minute ? number('count') + 1 : 1,
      day, daily_count: number('day') === day ? number('daily_count') + 1 : 1, action_id: path };
    const fields = (object) => Object.fromEntries(Object.entries(object).map(([key, item]) => [key, value(item)]));
    const prefix = `projects/${project}/databases/(default)/documents/`;
    const response = await fetch(`${base}:commit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(uid)}` },
      body: JSON.stringify({ writes: [
        { update: { name: prefix + quotaPath, fields: fields(quota) }, updateMask: { fieldPaths: Object.keys(quota) },
          updateTransforms: [{ fieldPath: 'updated_at', setToServerValue: 'REQUEST_TIME' }] },
        { update: { name: prefix + path, fields: fields(data) }, updateMask: { fieldPaths: Object.keys(data) } }
      ] })
    });
    return { status: response.status, body: await response.json() };
  }
  const mask = data ? '?' + Object.keys(data).map((key) => `updateMask.fieldPaths=${key}`).join('&') : '';
  const response = await fetch(`${base}/${path}${mask}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid === 'owner' ? 'owner' : token(uid)}` } : {}) },
    body: data ? JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([key, item]) => [key, value(item)])) }) : undefined
  });
  return { status: response.status, body: await response.json() };
}
async function allow(promise) {
  const result = await promise;
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result;
}
async function deny(promise) {
  const result = await promise;
  assert.equal(result.status, 403, JSON.stringify(result));
}
function message(uid, body = 'hello') {
  return { conversation_id: 'private', sender_id: uid, body, display_mode: 'plain',
    attachment_name: '', attachment_type: '', attachment_data: '', created_at: now };
}
const group = { id: 'private', type: 'group', title: 'Private', member_ids: ['alice', 'bob'],
  created_by_user_id: 'alice', created_at: now, updated_at: now, invite_version: '0' };

test('Firestore authorization and legitimate client operations', async (t) => {
  const rulePath = process.env.SECURITY_RULES_SOURCE || 'firestore.rules';
  const compiled = await fetch(`http://${host}/emulator/v1/projects/${project}:securityRules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: fs.readFileSync(rulePath, 'utf8') }] } })
  });
  assert.equal(compiled.status, 200, await compiled.text());
  await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' });
  await allow(request('conversations/private', 'owner', group));
  await allow(request('conversations/private/messages/seed', 'owner', message('alice')));
  for (const uid of ['alice', 'bob']) await allow(request(`users/${uid}`, 'owner', {
    uid, username: uid, username_lower: uid, profile_image_path: '', updated_at: now
  }));

  await t.test('anonymous users cannot read messages', () => deny(request('conversations/private/messages/seed', null)));
  await t.test('members can read messages without trusting a sidebar document', () => allow(request('conversations/private/messages/seed', 'bob')));
  await t.test('outsiders cannot read messages', () => deny(request('conversations/private/messages/seed', 'mallory')));
  await t.test('forged sidebar membership is rejected', async () => {
    const view = { ...group, conversation_id: 'private', member_ids: ['alice', 'bob', 'mallory'] };
    await deny(request('userConversations/mallory/items/private', 'mallory', view));
    // Simulate an old forged/stale sidebar entry: it must still confer no access.
    await allow(request('userConversations/mallory/items/private', 'owner', view));
    await deny(request('conversations/private/messages/seed', 'mallory'));
  });
  await t.test('outsiders cannot add themselves to a group', () => deny(request('conversations/private', 'mallory', { member_ids: ['alice', 'bob', 'mallory'] })));
  await t.test('members cannot rewrite group owner or add arbitrary accounts', async () => {
    await deny(request('conversations/private', 'bob', { created_by_user_id: 'bob' }));
    await deny(request('conversations/private', 'bob', { member_ids: ['alice', 'bob', 'mallory'] }));
    await deny(request('conversations/private', 'bob', undefined, 'DELETE'));
  });
  await t.test('sender impersonation and unsafe attachments are rejected', async () => {
    await deny(request('conversations/private/messages/spoof', 'bob', message('alice')));
    await deny(request('conversations/private/messages/html', 'bob', { ...message('bob'), attachment_type: 'text/html', attachment_data: 'data:text/html;base64,YQ==' }));
    await deny(request('conversations/private/messages/link', 'bob', { ...message('bob'), attachment_type: 'text/plain', attachment_data: 'javascript:alert(1)' }));
    await deny(request('conversations/private/messages/large', 'bob', message('bob', 'x'.repeat(4001))));
    await allow(request('conversations/private/messages/good', 'bob', { ...message('bob'), attachment_name: 'note.txt', attachment_type: 'text/plain', attachment_data: 'data:text/plain;base64,aGVsbG8=' }));
  });
  await t.test('requests cannot be forged or self-accepted', async () => {
    const data = { from_uid: 'alice', to_uid: 'bob', status: 'pending', created_at: now, responded_at: '' };
    await deny(request('friendRequests/alice_bob', 'mallory', data));
    await allow(request('friendRequests/alice_bob', 'alice', data));
    await deny(request('friendRequests/alice_bob', 'alice', { status: 'accepted' }));
    await deny(request('friendRequests/alice_bob', 'bob', { to_uid: 'mallory' }));
    await allow(request('userFriendRequests/bob/incoming/alice_bob', 'alice', data));
    await allow(request('userFriendRequests/alice/outgoing/alice_bob', 'alice', data));
    await deny(request('userFriendRequests/bob/incoming/forged', 'mallory', { ...data, from_uid: 'mallory' }));
    await allow(request('friendRequests/alice_bob', 'bob', { status: 'accepted', responded_at: now }));
  });
  await t.test('friendship needs consent, then the direct chat flow works', async () => {
    await deny(request('friendships/alice_mallory', 'mallory', { user_ids: ['alice', 'mallory'], created_at: now }));
    await allow(request('friendships/alice_bob', 'bob', { user_a_id: 'alice', user_b_id: 'bob', user_ids: ['alice', 'bob'], created_at: now }));
    const direct = { ...group, id: 'alice_bob', type: 'direct', title: '' };
    await allow(request('conversations/alice_bob', 'bob', direct));
    for (const [owner, other] of [['alice', 'bob'], ['bob', 'alice']]) {
      await allow(request(`userFriends/${owner}/items/${other}`, 'bob', { friend_uid: other, friendship_id: 'alice_bob', conversation_id: 'alice_bob', created_at: now }));
      await allow(request(`userConversations/${owner}/items/alice_bob`, 'bob', { ...direct, conversation_id: 'alice_bob' }));
    }
    await deny(request('friendships/alice_bob', 'mallory'));
    assert.equal((await request('friendships/missing', 'alice')).status, 404);
  });
  await t.test('owner can create a group and add a consenting friend', async () => {
    await allow(request('conversations/newgroup', 'alice', { ...group, id: 'newgroup', member_ids: ['alice'] }));
    await allow(request('conversations/newgroup', 'alice', { member_ids: ['alice', 'bob'], add_member_uid: 'bob', updated_at: now }));
    await deny(request('conversations/newgroup', 'alice', { member_ids: ['alice', 'bob', 'mallory'], add_member_uid: 'mallory' }));
  });
  await t.test('valid invite joins; expiry, revocation and missing tokens deny access', async () => {
    const key = 'a'.repeat(43);
    const invite = { token: key, conversation_id: 'private', conversation_title: 'Private', created_by_user_id: 'alice', invite_version: '0', expires_at: '', expires_at_ms: 0, revoked_at: '', created_at: now };
    await deny(request(`groupInvites/${key}`, 'bob', { ...invite, created_by_user_id: 'bob' }));
    await allow(request(`groupInvites/${key}`, 'alice', invite));
    await allow(request('conversations/private', 'mallory', { member_ids: ['alice', 'bob', 'mallory'], join_invite_token: key, updated_at: now }));
    await allow(request('conversations/private', 'owner', { member_ids: ['alice', 'bob'] }));
    await allow(request(`groupInvites/${key}`, 'owner', { expires_at_ms: Date.now() - 10000 }));
    await deny(request('conversations/private', 'mallory', { member_ids: ['alice', 'bob', 'mallory'], join_invite_token: key }));
    await allow(request(`groupInvites/${key}`, 'owner', { expires_at_ms: 0 }));
    await allow(request('conversations/private', 'alice', { invite_version: 'rotated', updated_at: now }));
    await deny(request('conversations/private', 'mallory', { member_ids: ['alice', 'bob', 'mallory'], join_invite_token: key }));
  });
  await t.test('leaving removes access even with a stale sidebar', async () => {
    await allow(request('userConversations/bob/items/private', 'owner', { ...group, conversation_id: 'private' }));
    await allow(request('conversations/private', 'bob', { member_ids: ['alice'], updated_at: now }));
    await deny(request('conversations/private/messages/seed', 'bob'));
  });
  await t.test('block prevents new direct messages and requests', async () => {
    await allow(request('userBlocks/alice/items/bob', 'alice', { blocker_user_id: 'alice', blocked_user_id: 'bob', created_at: now }));
    await deny(request('conversations/alice_bob/messages/blocked', 'bob', { ...message('bob'), conversation_id: 'alice_bob' }));
    await deny(request('friendRequests/bob_alice', 'bob', { from_uid: 'bob', to_uid: 'alice', status: 'pending', created_at: now, responded_at: '' }));
  });
  await t.test('public profiles reject email fields and private emails are owner-only', async () => {
    await allow(request('users/alice', 'owner', { uid: 'alice', username: 'alice', username_lower: 'alice', profile_image_path: '', updated_at: now }));
    await allow(request('usernames/alice', 'owner', { uid: 'alice' }));
    await allow(request('privateUsers/alice', 'owner', { email: 'alice@example.test', updated_at: now }));
    await allow(request('privateUsers/alice', 'alice'));
    await deny(request('privateUsers/alice', 'bob'));
    await deny(request('privateUsers/alice', null));
    await deny(request('users/alice', 'alice', { email: 'alice@example.test' }));
    await deny(request('usernames/alice', 'bob', { uid: 'bob' }));
    await allow(request('users/alice', 'bob'));
  });
  await t.test('message limits cannot be reset or bypassed with a direct write', async () => {
    const quotaPath = 'writeLimits/alice/buckets/messages';
    await allow(request(quotaPath, 'owner', { window: Math.floor(Date.now() / 60000), count: 60,
      day: Math.floor(Date.now() / 86400000), daily_count: 60, action_id: 'previous' }));
    await deny(request('conversations/private/messages/excessive', 'alice', message('alice')));
    await deny(request(quotaPath, 'alice', { count: 0 }));
    await deny(request(quotaPath, 'alice', undefined, 'DELETE'));
    const response = await fetch(`${base}/conversations/private/messages/unmetered`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token('alice')}` },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(message('alice')).map(([key, item]) => [key, value(item)])) })
    });
    assert.equal(response.status, 403);
  });
});

test('real preload client can request, accept, chat, invite, revoke and leave', async () => {
  if (process.env.SECURITY_RULES_SOURCE) return;
  await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' });
  function client(uid) {
    const exposed = {};
    const localRequire = createRequire(path.resolve('preload.js'));
    const context = vm.createContext({
      URLSearchParams, console, AbortSignal,
      btoa, atob, TextEncoder, TextDecoder, Uint8Array, crypto: require('node:crypto').webcrypto,
      require: (name) => name === 'electron'
        ? { contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } }, ipcRenderer: { invoke: async () => null } }
        : localRequire(name),
      fetch: (url, options = {}) => {
        if (String(url).startsWith('https://identitytoolkit.googleapis.com/v1/accounts:')) {
          const body = JSON.parse(options.body || '{}');
          if (String(url).includes('accounts:delete')) return Promise.resolve(Response.json({}));
          return Promise.resolve(Response.json({ localId: uid, email: body.email,
            idToken: token(uid), refreshToken: 'emulator-only', expiresIn: '3600' }));
        }
        if (!String(url).startsWith('https://firestore.googleapis.com/v1/projects/coded-messages/databases/(default)/documents')) {
          throw new Error('Client integration test attempted a non-emulator request.');
        }
        return fetch(String(url).replace('https://firestore.googleapis.com/v1/projects/coded-messages/databases/(default)/documents', base), {
          ...options,
          ...(options.body ? { body: options.body.replaceAll('projects/coded-messages/', `projects/${project}/`) } : {})
        });
      }
    });
    vm.runInContext(fs.readFileSync('preload.js', 'utf8'), context);
    const session = Buffer.from(JSON.stringify({ provider: 'firebase', idToken: token(uid), refreshToken: 'emulator-only', localId: uid, email: `${uid}@example.test`, expiresAt: Date.now() + 3600000 })).toString('base64url');
    const api = exposed.codedApi;
    return new Proxy(api, { get: (_target, key) => (...args) =>
      ['register', 'login'].includes(key) ? api[key](...args) : api[key](session, ...args) });
  }
  for (const uid of ['alice', 'bob', 'charlie']) {
    await allow(request(`users/${uid}`, 'owner', { uid, app_user_id: 0, username: uid, username_lower: uid, profile_image_path: '', last_seen_at: '', updated_at: now }));
    await allow(request(`privateUsers/${uid}`, 'owner', { email: `${uid}@example.test`, updated_at: now }));
    await allow(request(`usernames/${uid}`, 'owner', { uid }));
  }
  const alice = client('alice');
  const bob = client('bob');
  const charlie = client('charlie');
  await alice.sendFriendRequest('bob');
  const incoming = await bob.getFriendRequests();
  assert.equal(incoming.requests.length, 1);
  await bob.acceptFriendRequest(incoming.requests[0].id);
  assert.equal((await alice.getFriends()).friends.length, 1);
  assert.equal((await bob.getConversations()).conversations.length, 1);
  await alice.sendMessage('alice_bob', 'test plain', 'plain');
  await bob.sendMessage('alice_bob', 'test coded', 'coded');
  assert.equal((await bob.getMessages('alice_bob')).messages.length, 2);
  const groupResponse = await alice.createGroupConversation('Test group', ['bob']);
  const id = groupResponse.conversation_id;
  const invite = await alice.createGroupInvite(id, 'never');
  await charlie.getGroupInvite(invite.token);
  await charlie.joinGroupInvite(invite.token);
  await charlie.sendMessage(id, 'joined', 'plain');
  assert.equal((await alice.getMessages(id)).messages.length, 1);
  await alice.revokeGroupInvites(id);
  await charlie.leaveConversation(id);
  await assert.rejects(charlie.joinGroupInvite(invite.token));
  await deny(request(`conversations/${id}/messages`, 'charlie'));
  await alice.removeFriend('bob');
  assert.equal((await bob.getFriends()).friends.length, 0);
  await alice.sendFriendRequest('bob');
  await bob.acceptFriendRequest((await bob.getFriendRequests()).requests[0].id);
  const raced = await Promise.allSettled([
    alice.updateProfile({ username: 'same_name' }), bob.updateProfile({ username: 'same_name' })
  ]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((result) => result.status === 'rejected').length, 1);
  const publicAlice = await allow(request('users/alice', 'bob'));
  const publicBob = await allow(request('users/bob', 'alice'));
  assert.equal(Object.hasOwn(publicAlice.body.fields, 'email'), false);
  assert.equal(Object.hasOwn(publicBob.body.fields, 'email'), false);
  assert.equal((await alice.getMe()).user.email, 'alice@example.test');
  const dana = client('dana');
  await dana.register({ email: 'dana@example.test', password: 'a-long-test-password', username: 'new_account' });
  const registered = await allow(request('users/dana', 'bob'));
  assert.equal(Object.hasOwn(registered.body.fields, 'email'), false);
  await deny(request('privateUsers/dana', 'bob'));
  await dana.login({ email: 'dana@example.test', password: 'a-long-test-password' });
  assert.equal((await dana.getMe()).user.email, 'dana@example.test');
});
