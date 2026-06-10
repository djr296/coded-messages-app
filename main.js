const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { createApiServer } = require("./server");

let apiServer;
const CLOUD_API_BASE = "https://coded-messages-api.onrender.com";
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
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("pick-profile-image", async () => {
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

ipcMain.handle("pick-message-attachment", async () => {
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

  return readFileAsDataUrl(result.filePaths[0], ATTACHMENT_TYPES, 2 * 1024 * 1024);
});

app.whenReady().then(async () => {
  const externalApiBase = process.env.CODED_MESSAGES_API_BASE;
  const resolvedApiBase = externalApiBase || (app.isPackaged ? CLOUD_API_BASE : "http://127.0.0.1:3847");

  process.env.CODED_MESSAGES_API_BASE = resolvedApiBase;

  if (!externalApiBase && !app.isPackaged) {
    apiServer = await createApiServer({ port: 3847, allowInsecureDevJwt: true });
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", async () => {
  if (apiServer) {
    try {
      await apiServer.close();
    } catch (_err) {
      // Ignore shutdown errors.
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
