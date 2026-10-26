const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jar = process.env.FIRESTORE_EMULATOR_JAR || path.join(os.homedir(), '.cache', 'firebase', 'emulators', 'cloud-firestore-emulator-v1.21.0.jar');
if (!fs.existsSync(jar)) throw new Error('Firestore emulator JAR not found. Set FIRESTORE_EMULATOR_JAR or install it with the Firebase CLI.');
const emulator = spawn('java', ['-jar', jar, '--host', '127.0.0.1', '--port', '8787',
  '--project_id', 'demo-coded-messages', '--single_project_mode', 'true', '--rules', 'firestore.rules'], { windowsHide: true });
let diagnostics = '';
emulator.stdout.on('data', (data) => { diagnostics = (diagnostics + data).slice(-12000); });
emulator.stderr.on('data', (data) => { diagnostics = (diagnostics + data).slice(-12000); });
emulator.on('error', (error) => { diagnostics += error.message; });
async function run() {
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (emulator.exitCode !== null) throw new Error('Firestore emulator exited before startup.');
      try {
        await fetch('http://127.0.0.1:8787/', { signal: AbortSignal.timeout(500) });
        ready = true;
        break;
      } catch (_) { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    if (!ready) throw new Error('Firestore emulator startup timed out.');
    const result = await new Promise((resolve, reject) => {
      const tests = spawn(process.execPath, ['--test', 'tests/firestore-security.test.js'], {
        stdio: 'inherit', windowsHide: true, env: { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8787' }
      });
      tests.on('error', reject);
      tests.on('exit', (code) => resolve(code === null ? 1 : code));
    });
    process.exitCode = result;
  } catch (error) {
    console.error(error.message + '\n' + diagnostics);
    process.exitCode = 1;
  } finally {
    emulator.kill();
  }
}
run();
