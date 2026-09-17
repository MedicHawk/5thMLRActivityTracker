import { spawnSync } from 'node:child_process';

const probe = () => spawnSync(process.execPath, ['-e', 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.close();'], {encoding: 'utf8'});

if (probe().status !== 0) {
  console.log('SQLite native binding is missing; rebuilding better-sqlite3.');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const rebuilt = spawnSync(npm, ['rebuild', 'better-sqlite3'], {stdio: 'inherit', shell: process.platform === 'win32'});
  if (rebuilt.status !== 0) throw new Error('better-sqlite3 rebuild failed; use a supported Node.js version.');
  const checked = probe();
  if (checked.status !== 0) throw new Error(`better-sqlite3 still cannot load: ${checked.stderr}`);
}
