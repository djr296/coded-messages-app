const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeDataUrl, validateAttachment } = require('../shared/content-security');
const { createSessionStore } = require('../shared/session-store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { privacyPlan } = require('../shared/privacy-migration');
const { encodeSessionToken, decodeSessionToken, randomId } = require('../shared/session-token');

test('only bounded, explicit attachment formats are accepted', () => {
  const txt = 'data:text/plain;base64,aGVsbG8=';
  assert.equal(safeDataUrl(txt, 'text/plain'), txt);
  assert.equal(safeDataUrl(txt, 'image/png'), '');
  for (const url of ['javascript:alert(1)', 'file:///C:/private.txt', 'https://tracker.example/a.png', 'data:text/html;base64,YQ==', 'data:image/svg+xml;base64,YQ==']) {
    assert.equal(safeDataUrl(url), '');
  }
  assert.equal(safeDataUrl(txt, null, true), '');
  assert.equal(safeDataUrl('data:text/plain;base64,' + Buffer.alloc(512 * 1024 + 1).toString('base64')), '');
  assert.throws(() => validateAttachment({ type: 'text/html', data: 'data:text/html;base64,YQ==' }));
  assert.equal(validateAttachment({ name: '../note.txt', type: 'text/plain', data: txt }).name, '.._note.txt');
});

test('browser session tokens remain compatible and random IDs are bounded', () => {
  const state = { localId: 'alice', refreshToken: 'refresh', idToken: 'id', email: 'alice@example.test', expiresAt: 12345 };
  const encoded = encodeSessionToken(state);
  assert.equal(decodeSessionToken(encoded).localId, state.localId);
  assert.deepEqual(decodeSessionToken(Buffer.from(JSON.stringify({ provider: 'firebase', ...state })).toString('base64url')), { provider: 'firebase', ...state });
  assert.equal(decodeSessionToken('invalid'), null);
  assert.notEqual(randomId(), randomId());
});

test('privacy migration preserves account data privately and resolves username collisions', () => {
  const prefix = 'projects/demo-coded-messages/databases/(default)/documents';
  const users = ['alice', 'bob'].map((uid) => ({
    name: `${prefix}/users/${uid}`, updateTime: '2026-01-01T00:00:00Z',
    fields: { uid: { stringValue: uid }, username: { stringValue: 'same' }, username_lower: { stringValue: 'same' },
      email: { stringValue: `${uid}@example.test` }, profile_image_path: { stringValue: '' } }
  }));
  const plan = privacyPlan(users);
  assert.equal(plan.summary.publicEmailsToRemove, 2);
  assert.equal(plan.summary.usernamesRenamed, 1);
  const publicWrites = plan.writes.filter((write) => write.update.name.includes('/users/'));
  assert.ok(publicWrites.every((write) => !Object.hasOwn(write.update.fields, 'email')));
  const privateWrites = plan.writes.filter((write) => write.update.name.includes('/privateUsers/'));
  assert.equal(privateWrites.length, 2);
  const reservations = plan.writes.filter((write) => write.update.name.includes('/usernames/'));
  assert.equal(new Set(reservations.map((write) => write.update.name)).size, 2);
  assert.ok(publicWrites.every((write) => write.currentDocument.updateTime));
});

test('saved sessions require encryption and can be removed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coded-session-test-'));
  const file = path.join(directory, 'session.bin');
  try {
    const unavailable = createSessionStore(file, { isEncryptionAvailable: () => false });
    assert.throws(() => unavailable.save('refresh-token'));
    assert.equal(fs.existsSync(file), false);
    const store = createSessionStore(file, {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('encrypted-test-value'),
      decryptString: () => 'refresh-token'
    });
    store.save('refresh-token');
    assert.equal(fs.readFileSync(file, 'utf8').includes('refresh-token'), false);
    assert.equal(store.load(), 'refresh-token');
    store.save('');
    assert.equal(store.load(), '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
