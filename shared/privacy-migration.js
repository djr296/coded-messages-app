const { createHash } = require('node:crypto');
const { safeDataUrl } = require('./content-security');

function privacyPlan(users, privateRecords = [], reservations = []) {
  const byName = new Map(reservations.map((doc) => [doc.name.split('/').pop(), doc]));
  const privateByUid = new Map(privateRecords.map((doc) => [doc.name.split('/').pop(), doc]));
  const used = new Map([...byName].map(([key, doc]) => [key, doc.fields.uid?.stringValue]));
  const writes = [];
  let renamed = 0;
  let emailsRemoved = 0;
  let invalidImagesRemoved = 0;
  for (const doc of [...users].sort((a, b) => a.name.localeCompare(b.name))) {
    const uid = doc.name.split('/').pop();
    const prefix = doc.name.slice(0, doc.name.lastIndexOf('/users/'));
    const fields = doc.fields || {};
    let display = fields.username?.stringValue || '';
    let key = display.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(key) || (used.has(key) && used.get(key) !== uid)) {
      const suffix = createHash('sha256').update(uid).digest('hex').slice(0, 12);
      display = `user_${suffix}`;
      key = display;
      while (used.has(key) && used.get(key) !== uid) {
        display = `user_${createHash('sha256').update(uid + key).digest('hex').slice(0, 20)}`;
        key = display;
      }
      renamed++;
    }
    display = display.trim();
    used.set(key, uid);
    const publicFields = {
      uid: { stringValue: uid }, app_user_id: fields.app_user_id || { integerValue: '0' },
      username: { stringValue: display }, username_lower: { stringValue: key },
      profile_image_path: { stringValue: safeDataUrl(fields.profile_image_path?.stringValue || '', null, true) },
      last_seen_at: fields.last_seen_at || { stringValue: '' }, updated_at: { stringValue: new Date().toISOString() }
    };
    if (fields.profile_image_path?.stringValue && !publicFields.profile_image_path.stringValue) invalidImagesRemoved++;
    if (Object.hasOwn(fields, 'email')) emailsRemoved++;
    const privateDoc = privateByUid.get(uid);
    const email = privateDoc?.fields.email?.stringValue || fields.email?.stringValue || '';
    writes.push({ update: { name: doc.name, fields: publicFields }, currentDocument: { updateTime: doc.updateTime } });
    if (email) writes.push({
      update: { name: `${prefix}/privateUsers/${uid}`, fields: { email: { stringValue: email }, updated_at: publicFields.updated_at } },
      updateMask: { fieldPaths: ['email', 'updated_at'] },
      currentDocument: privateDoc ? { updateTime: privateDoc.updateTime } : { exists: false }
    });
    if (!byName.has(key)) writes.push({
      update: { name: `${prefix}/usernames/${key}`, fields: { uid: { stringValue: uid } } }, currentDocument: { exists: false }
    });
  }
  return { writes, summary: { users: users.length, publicEmailsToRemove: emailsRemoved,
    usernamesRenamed: renamed, invalidImagesRemoved, writes: writes.length } };
}
module.exports = { privacyPlan };
