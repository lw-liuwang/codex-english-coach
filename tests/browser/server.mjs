import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildServer } from '../../apps/server/dist/app.js';

const prefix = join(tmpdir(), 'codex-english-coach-browser-');
const dataDir = await mkdtemp(prefix);
let now = new Date('2026-11-23T02:00:00Z');
const app = await buildServer({ dataDir, now: () => now });

// Test-only routes keep clock control out of the production API.
app.post('/__test/reset', async () => {
  const db = new DatabaseSync(join(dataDir, 'learning.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE; DELETE FROM reviews; DELETE FROM encounters; DELETE FROM cards; DELETE FROM captures; COMMIT;');
  } finally { db.close(); }
  now = new Date('2026-11-23T02:00:00Z');
  return { ok: true };
});
app.post('/__test/advance-clock', async request => {
  const { days } = request.body;
  if (!Number.isInteger(days) || days < 0 || days > 1000) throw new Error('Invalid test clock');
  now = new Date(now.getTime() + days * 86400000);
  return { now: now.toISOString() };
});

await app.listen({ host: '127.0.0.1', port: Number(process.env.COACH_BROWSER_PORT || 47839) });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  if (resolve(dataDir).startsWith(resolve(tmpdir()) + sep) && dataDir.startsWith(prefix)) {
    await rm(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
