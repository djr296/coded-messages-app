const path = require("path");
const { createApiServer } = require("./index");

const host = process.env.CODED_MESSAGES_HOST || "0.0.0.0";
const port = Number(process.env.PORT || process.env.CODED_MESSAGES_PORT || 3847);
const dbPath = process.env.CODED_MESSAGES_DB_PATH || path.join(__dirname, "..", "data", "app.sqlite");

let serverHandle;

async function start() {
  serverHandle = await createApiServer({ host, port, dbPath });
  console.log(`Coded Messages API listening on http://${serverHandle.host}:${serverHandle.port}`);
  console.log(`Database backend: ${serverHandle.databaseKind}`);
  if (serverHandle.dbPath) {
    console.log(`Database path: ${serverHandle.dbPath}`);
  }
}

async function shutdown() {
  if (!serverHandle) {
    process.exit(0);
  }

  try {
    await serverHandle.close();
    process.exit(0);
  } catch (err) {
    console.error("Failed to shut down API server cleanly.");
    console.error(err);
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
  console.error("Failed to start Coded Messages API.");
  console.error(err);
  process.exit(1);
});
