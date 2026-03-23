const { app, BrowserWindow } = require("electron");
const path = require("path");
const { createApiServer } = require("./server");

let apiServer;
const CLOUD_API_BASE = "https://coded-messages-api.onrender.com";

function createWindow() {
  const win = new BrowserWindow({
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

app.whenReady().then(async () => {
  const externalApiBase = process.env.CODED_MESSAGES_API_BASE;
  const resolvedApiBase = externalApiBase || (app.isPackaged ? CLOUD_API_BASE : "http://127.0.0.1:3847");

  process.env.CODED_MESSAGES_API_BASE = resolvedApiBase;

  if (!externalApiBase && !app.isPackaged) {
    apiServer = await createApiServer({ port: 3847 });
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
