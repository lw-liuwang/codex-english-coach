import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT_DIR, resolveConfig, ensureBackend, stopBackend } from '../scripts/runtime.mjs';

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connect(config, autoStart = true) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT_DIR, 'packages', 'mcp', 'dist', 'main.js')],
    env: { ...process.env, COACH_DATA_DIR: config.dataDir, COACH_PORT: String(config.port), COACH_AUTO_START: autoStart ? '1' : '0' },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'english-coach-integration-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('real MCP stdio handshake, offline capture and replay use one persisted learning event', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coach-mcp-'));
  const config = resolveConfig({ COACH_DATA_DIR: directory, COACH_PORT: String(await unusedPort()) });
  t.after(async () => {
    await stopBackend(config);
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const offline = await connect(config, false);
  const tools = await offline.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'capture_learning'));
  const input = {
    id: randomUUID(), source: 'writing', sourceLabel: 'stdio test',
    points: [{ kind: 'word', expression: 'retry', meaning: '重试', context: 'Please add a retry button.', explanation: 'retry 在这里表示重试。', original: '重试 button', prompt: '说出“重试”的英文。' }]
  };
  const queued = await offline.callTool({ name: 'capture_learning', arguments: input });
  assert.equal(queued.isError, undefined);
  assert.equal(queued.structuredContent.status, 'queued');
  assert.equal(JSON.parse(await readFile(path.join(config.outboxDir, `${input.id}.json`), 'utf8')).points[0].original, '重试 button');
  const invalid = await offline.callTool({ name: 'capture_learning', arguments: { ...input, points: [] } });
  assert.equal(invalid.isError, true);
  assert.equal((await readdir(config.outboxDir)).filter(value => value.endsWith('.json')).length, 1);
  await offline.close();
  await ensureBackend(config);
  const online = await connect(config);
  t.after(async () => { await online.close(); });
  const replay = await online.callTool({ name: 'capture_learning', arguments: input });
  assert.equal(replay.isError, undefined);
  assert.equal(replay.structuredContent.status, 'saved');
  const cards = await fetch(`${config.baseUrl}/api/cards`).then(response => response.json());
  assert.equal(cards.total, 1);
  assert.equal(cards.items[0].source, 'writing');
  assert.equal(cards.items[0].encounters, 1);
});
