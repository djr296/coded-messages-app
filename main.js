const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const APP_URL = pathToFileURL(path.join(__dirname, "renderer", "index.html")).href;
const { createSessionStore } = require('./shared/session-store');
const { lockDownWindow } = require('./shared/window-security');
let sessionStore;
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};
const ATTACHMENT_TYPES = {
  ...IMAGE_TYPES,
  ".pdf": "application/pdf",
  ".txt": "text/plain"
};

function readFileAsDataUrl(filePath, allowedTypes, maxBytes) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = allowedTypes[extension];
  if (!mimeType) {
    throw new Error("That file type is not supported.");
  }

  const stats = fs.statSync(filePath);
  if (stats.size > maxBytes) {
    throw new Error(`File is too large. Maximum size is ${Math.floor(maxBytes / 1024)} KB.`);
  }

  const data = fs.readFileSync(filePath).toString("base64");
  return {
    name: path.basename(filePath),
    type: mimeType,
    data: `data:${mimeType};base64,${data}`
  };
}

function createWindow() {
  const win = new BrowserWindow({
    title: "Coded Messages",
    icon: path.join(__dirname, "assets", "app-icon.png"),
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, "generated", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  lockDownWindow(win, APP_URL);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function assertTrustedSender(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== APP_URL) {
    throw new Error("Untrusted application frame.");
  }
}

ipcMain.handle('load-session', (event) => {
  assertTrustedSender(event);
  return sessionStore.load();
});
ipcMain.handle('save-session', (event, token) => {
  assertTrustedSender(event);
  sessionStore.save(token);
});

ipcMain.handle("pick-profile-image", async (event) => {
  assertTrustedSender(event);
  const result = await dialog.showOpenDialog({
    title: "Choose profile image",
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }
    ]
  });

  if (result.canceled || !result.filePaths.length) {
    return "";
  }

  return readFileAsDataUrl(result.filePaths[0], IMAGE_TYPES, 512 * 1024).data;
});

ipcMain.handle("pick-message-attachment", async (event) => {
  assertTrustedSender(event);
  const result = await dialog.showOpenDialog({
    title: "Attach a file",
    properties: ["openFile"],
    filters: [
      { name: "Supported files", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt"] }
    ]
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  return readFileAsDataUrl(result.filePaths[0], ATTACHMENT_TYPES, 512 * 1024);
});

app.whenReady().then(() => {
  sessionStore = createSessionStore(path.join(app.getPath('userData'), 'coded-session.bin'), safeStorage);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
