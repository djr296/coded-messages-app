const { execFileSync, spawnSync } = require('node:child_process');
const refs = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).trim().split(/\s+/);
const patterns = {
  privateKeys: 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY',
  githubTokens: 'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}',
  brevoKeys: 'xkeysib-[A-Za-z0-9-]{40,}',
  serviceAccountKeys: '"private_key"[[:space:]]*:[[:space:]]*"[^"[:space:]]+'
};
for (const [check, pattern] of Object.entries(patterns)) {
  let matches = 0;
  for (const ref of refs) {
    const result = spawnSync('git', ['grep', '-I', '-l', '-E', pattern, ref, '--', '.'], { encoding: 'utf8' });
    if (result.status === 0) matches += result.stdout.trim().split('\n').length;
    else if (result.status !== 1) throw new Error('Historical secret scan failed.');
  }
  console.log(JSON.stringify({ check, matchingHistoricalFiles: matches }));
}
console.log(JSON.stringify({ commitsChecked: refs.length }));
