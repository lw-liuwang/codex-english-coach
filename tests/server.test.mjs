import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildServer } from '../apps/server/dist/app.js';
import { CaptureInputSchema, nextSchedule, shanghaiDate } from '../packages/shared/dist/index.js';

function capture(overrides = {}) {
  return { id: randomUUID(), source: 'reading', sourceLabel: 'A test project', points: [{
    kind: 'phrase', expression: 'time out', meaning: '超时',
    context: 'The request timed out.', explanation: '等待结果超过了规定时间；timed 是 time 的过去式。',
    original: '', prompt: 'The request timed out.'
  }], ...overrides };
}

async function fixture(t, initial = '2026-11-22T16:01:00Z') {
  const dataDir = await mkdtemp(join(tmpdir(), 'english-coach-server-'));
  let clock = new Date(initial);
  const app = await buildServer({ dataDir, now: () => clock });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, dataDir, setClock(value) { clock = new Date(value); } };
}
async function post(app, url, payload) { return app.inject({ method: 'POST', url, payload }); }
async function get(app, url) { return (await app.inject({ method: 'GET', url })).json(); }

test('capture retries are idempotent and a reused ID with other content is rejected', async t => {
  const { app } = await fixture(t);
  const input = capture();
  assert.equal((await post(app, '/api/captures', input)).json().created, 1);
  assert.equal((await post(app, '/api/captures', input)).json().replayed, true);
  assert.equal((await post(app, '/api/captures', { ...input, source: 'writing' })).statusCode, 409);
  const list = await get(app, '/api/cards');
  assert.equal(list.total, 1);
  assert.equal(list.items[0].encounters, 1);
  assert.equal((await get(app, `/api/cards/${list.items[0].id}`)).encounters.length, 1);
  const invalid = await post(app, '/api/captures', { ...capture(), rawConversation: 'must not be stored' });
  assert.equal(invalid.statusCode, 400);
});

test('same senses retain encounters while direction and other senses stay separate', async t => {
  const { app } = await fixture(t);
  const first = capture();
  await post(app, '/api/captures', first);
  const second = capture();
  second.points[0].context = 'The upload timed out after 30 seconds.';
  const repeat = (await post(app, '/api/captures', second)).json();
  assert.equal(repeat.matched, 1);
  await post(app, '/api/captures', capture({ source: 'writing', points: [{
    ...first.points[0], prompt: '请求等待太久，请说明“超时”。'
  }] }));
  await post(app, '/api/captures', capture({ points: [{ ...first.points[0], meaning: '体育比赛中的暂停' }] }));
  const list = await get(app, '/api/cards');
  assert.equal(list.total, 3);
  const item = list.items.find(card => card.source === 'reading' && card.meaning === '超时');
  assert.equal(item.encounters, 2);
  assert.equal((await get(app, `/api/cards/${item.id}`)).encounters.length, 2);
  assert.equal((await get(app, '/api/cards?source=writing')).total, 1);
});

test('reviews use Shanghai dates, reject early/stale scores, and persist an honest history', async t => {
  const { app, setClock } = await fixture(t);
  await post(app, '/api/captures', capture());
  const card = (await get(app, '/api/cards')).items[0];
  assert.equal(card.dueDate, '2026-11-24');
  assert.equal((await get(app, '/api/reviews/queue')).total, 0);
  const input = { id: randomUUID(), cardId: card.id, rating: 'familiar' };
  assert.equal((await post(app, '/api/reviews', input)).statusCode, 409);
  setClock('2026-11-23T16:01:00Z');
  assert.equal((await get(app, '/api/reviews/queue')).total, 1);
  const grade = (await post(app, '/api/reviews', input)).json();
  assert.equal(grade.card.step, 1);
  assert.equal(grade.card.dueDate, '2026-11-27');
  assert.equal((await post(app, '/api/reviews', input)).json().replayed, true);
  assert.equal((await post(app, '/api/reviews', { ...input, id: randomUUID() })).statusCode, 409);
  assert.equal((await post(app, '/api/reviews', { ...input, rating: 'forgot' })).statusCode, 409);
  setClock('2026-11-26T16:01:00Z');
  const hard = (await post(app, '/api/reviews', { ...input, id: randomUUID(), rating: 'hard' })).json();
  assert.equal(hard.card.step, 0);
  assert.equal(hard.card.dueDate, '2026-11-28');
  const detail = await get(app, `/api/cards/${card.id}`);
  assert.equal(detail.reviews.length, 2);
  assert.equal(detail.reviews[0].rating, 'hard');
  assert.equal((await get(app, '/api/stats')).due, 0);
});

test('all review intervals and the daily promotion limit follow the specified ladder', () => {
  assert.equal(shanghaiDate(new Date('2026-11-22T16:01:00Z')), '2026-11-23');
  const today = '2026-11-23';
  assert.deepEqual(nextSchedule({ step: 3, lastPromotedDate: null }, 'forgot', today), {
    step: 0, lastPromotedDate: null, dueDate: '2026-11-24'
  });
  assert.equal(nextSchedule({ step: 3, lastPromotedDate: null }, 'hard', today).dueDate, '2026-11-30');
  const first = nextSchedule({ step: 3, lastPromotedDate: null }, 'familiar', today);
  assert.equal(first.step, 4);
  assert.equal(first.dueDate, '2026-12-23');
  assert.equal(nextSchedule(first, 'familiar', today).step, 4);
  assert.equal(nextSchedule({ step: 5, lastPromotedDate: null }, 'familiar', today).dueDate, '2027-01-22');
});

test('editing preserves history; archive, search and Shanghai date filters work', async t => {
  const { app, setClock } = await fixture(t);
  await post(app, '/api/captures', capture());
  const card = (await get(app, '/api/cards')).items[0];
  assert.equal((await get(app, '/api/cards?from=2026-11-23&to=2026-11-23')).total, 1);
  assert.equal((await get(app, '/api/cards?q=超时')).total, 1);
  assert.equal((await get(app, '/api/cards?q=%25')).total, 0);
  const patch = await app.inject({ method: 'PATCH', url: `/api/cards/${card.id}`, payload: {
    explanation: '我自己的释义', archived: true
  } });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.json().explanation, '我自己的释义');
  assert.equal((await get(app, '/api/cards')).total, 0);
  assert.equal((await get(app, '/api/cards?archived=true')).total, 1);
  setClock('2026-12-01T00:00:00Z');
  assert.equal((await get(app, '/api/reviews/queue')).total, 0);
  assert.equal((await get(app, `/api/cards/${card.id}`)).encounters[0].explanation.includes('等待'), true);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/cards/${card.id}`, payload: {} })).statusCode, 400);
  assert.equal((await app.inject('/api/cards?from=2026-02-31')).statusCode, 400);
  assert.equal((await app.inject('/api/cards?limit=-1')).statusCode, 400);
});

test('startup imports a pending capture once and isolates invalid queue files', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'english-coach-outbox-'));
  const outbox = join(dataDir, 'outbox');
  await mkdir(outbox);
  const input = capture();
  await writeFile(join(outbox, `${input.id}.json`), JSON.stringify(input));
  await writeFile(join(outbox, 'invalid.json'), '{broken');
  let app = await buildServer({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await get(app, '/api/cards')).total, 1);
  assert.deepEqual((await readdir(outbox)).filter(name => name.endsWith('.json')), []);
  assert.equal((await readdir(join(outbox, 'failed'))).length, 1);
  await app.close();
  await writeFile(join(outbox, `${input.id}.json`), JSON.stringify(input));
  app = await buildServer({ dataDir });
  assert.equal((await get(app, '/api/cards')).items[0].encounters, 1);
});

test('database backup and JSON export preserve records and reviews', async t => {
  const { app } = await fixture(t);
  await post(app, '/api/captures', capture());
  const backupResponse = await post(app, '/api/system/backup', {});
  assert.equal(backupResponse.statusCode, 200);
  const backupDb = new DatabaseSync(backupResponse.json().path, { readOnly: true });
  assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM cards').get().count, 1);
  backupDb.close();
  const exported = await app.inject('/api/export');
  assert.match(exported.headers['content-disposition'], /attachment/);
  assert.equal(exported.json().cards.length, 1);
  assert.equal(exported.json().encounters.length, 1);
  assert.equal(exported.json().schemaVersion, 1);
});

test('parallel capture requests retain every distinct encounter and block foreign origins', async t => {
  const { app } = await fixture(t);
  const inputs = Array.from({ length: 20 }, () => capture());
  const results = await Promise.all(inputs.map(input => post(app, '/api/captures', input)));
  assert.equal(results.every(response => response.statusCode === 200), true);
  assert.equal((await get(app, '/api/cards')).items[0].encounters, 20);
  const blocked = await app.inject({ method: 'POST', url: '/api/captures', payload: capture(), headers: { origin: 'https://example.com' } });
  assert.equal(blocked.statusCode, 403);
  const rebound = await app.inject({ method: 'GET', url: '/api/export', headers: {
    host: 'attacker.example:47831', origin: 'http://attacker.example:47831'
  } });
  assert.equal(rebound.statusCode, 403);
  const wrongShutdown = await post(app, '/api/system/shutdown', { instanceId: randomUUID() });
  assert.equal(wrongShutdown.statusCode, 409);
});

test('HTTP and the queue use the shared UTF-8 capture size limit', async t => {
  const { app } = await fixture(t);
  const point = {
    kind: 'phrase', expression: 'a'.repeat(12000), meaning: 'b'.repeat(12000),
    context: 'c'.repeat(12000), explanation: 'd'.repeat(12000), original: 'e'.repeat(12000), prompt: 'f'.repeat(12000)
  };
  const nearLimit = capture({ points: Array.from({ length: 28 }, () => point) });
  assert.equal(CaptureInputSchema.safeParse(nearLimit).success, true);
  assert.equal((await post(app, '/api/captures', nearLimit)).statusCode, 200);
  const tooLarge = capture({ points: Array.from({ length: 30 }, () => point) });
  assert.equal(CaptureInputSchema.safeParse(tooLarge).success, false);
  assert.equal((await post(app, '/api/captures', tooLarge)).statusCode, 413);
  assert.equal((await get(app, '/api/cards')).total, 1);
});
