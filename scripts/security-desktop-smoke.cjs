const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { lockDownWindow } = require('../shared/window-security');
const root = process.env.CODED_MESSAGES_SMOKE_ROOT
  ? path.resolve(process.env.CODED_MESSAGES_SMOKE_ROOT) : path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coded-desktop-security-'));
app.setPath('userData', temporary);
ipcMain.handle('load-session', () => '');
ipcMain.handle('save-session', () => undefined);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'generated', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  try {
    const entry = path.join(root, 'renderer', 'index.html');
    lockDownWindow(win, pathToFileURL(entry).href);
    await win.loadFile(entry);
    const status = await win.webContents.executeJavaScript(`({
      bridgeLoaded: typeof window.codedApi?.sendMessage === 'function',
      rendererHasNode: typeof require !== 'undefined',
      contentPolicy: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'),
      unsafeLinkBlocked: window.codedContentSecurity.safeDataUrl('javascript:alert(1)') === '',
      popupBlocked: window.open('https://example.com') === null,
      evalBlocked: (() => { try { eval('1'); return false; } catch (_) { return true; } })()
    })`);
    assert.deepEqual(status, { bridgeLoaded: true, rendererHasNode: false, contentPolicy: true, unsafeLinkBlocked: true, popupBlocked: true, evalBlocked: true });
    const sandboxed = win.webContents.getLastWebPreferences().sandbox;
    assert.equal(sandboxed, true);
    const isolated = await win.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `({
      webCrypto: typeof globalThis.crypto.getRandomValues === 'function',
      encoding: typeof btoa === 'function' && typeof TextEncoder === 'function',
      nodeAbsent: typeof Buffer === 'undefined'
    })` }]);
    assert.deepEqual(isolated, { webCrypto: true, encoding: true, nodeAbsent: true });
    console.log(JSON.stringify({ electron: process.versions.electron, sandboxed, ...status, ...isolated }));
    app.exit(0);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
}).catch((error) => { console.error(error.message); app.exit(1); });
