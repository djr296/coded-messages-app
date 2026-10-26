const fs = require('node:fs');
const path = require('node:path');

function createSessionStore(filePath, safeStorage) {
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure session storage is unavailable. Sign in for this session only.');
  }
  return {
    load() {
      if (!fs.existsSync(filePath)) return '';
      if (fs.statSync(filePath).size > 65536) throw new Error('Saved session is invalid. Sign in again.');
      requireEncryption();
      return safeStorage.decryptString(fs.readFileSync(filePath));
    },
    save(token) {
      if (typeof token !== 'string' || token.length > 32768) throw new Error('Invalid saved session.');
      if (!token) {
        fs.rmSync(filePath, { force: true });
        return;
      }
      requireEncryption();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, safeStorage.encryptString(token), { mode: 0o600 });
      fs.renameSync(tempPath, filePath);
    }
  };
}

module.exports = { createSessionStore };
