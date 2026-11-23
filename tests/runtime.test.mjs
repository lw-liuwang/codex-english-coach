import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, resolveConfig, ensureBackend, health, stopBackend, queueCapture, deliverCapture, BackendConflictError } from '../scripts/runtime.mjs';
import { stripManagedBlock } from '../scripts/cli.mjs';

const backends = new WeakMap();

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coach-runtime-'));
  backends.set(t, []);
  t.after(async () => {
    for (const config of backends.get(t)) await stopBackend(config);
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function capture(overrides = {}) {
  return {
    id: randomUUID(), source: 'reading', sourceLabel: 'runtime test',
    points: [{ kind: 'phrase', expression: 'time out', meaning: '超时', context: 'The request timed out.', explanation: 'timed out 表示等待超过允许时间。', original: '', prompt: 'The request timed out.' }],
    ...overrides
  };
}

async function until(check, milliseconds = 7000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for observable state');
}

function execute(command, args, cwd = ROOT_DIR, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const cli = (args, env, cwd = ROOT_DIR) => execute(process.execPath, ['scripts/cli.mjs', ...args], cwd, env);

async function fakeCodex(directory) {
  const filename = path.join(directory, 'fake codex.mjs');
  await writeFile(filename, `
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const file = path.join(process.env.CODEX_HOME, 'mock-mcp.json');
if (args[0] === '--version') { console.log('codex-cli test'); process.exit(0); }
if (args[1] === 'get') {
  if (!existsSync(file)) { console.error('No MCP server named codex-english-coach found.'); process.exit(1); }
  console.log(readFileSync(file, 'utf8')); process.exit(0);
}
if (args[1] === 'remove') { if (existsSync(file)) unlinkSync(file); process.exit(0); }
if (args[1] === 'add') {
  const separator = args.indexOf('--'); const env = {};
  for (let i = 3; i < separator; i++) { if (args[i] === '--env') { const part = args[++i]; const equal = part.indexOf('='); env[part.slice(0, equal)] = part.slice(equal + 1); } }
  writeFileSync(file, JSON.stringify({ name: args[2], transport: { type: 'stdio', command: args[separator + 1], args: args.slice(separator + 2), env } }));
  process.exit(0);
}
console.error('Unexpected command'); process.exit(2);
`);
  return filename;
}

test('runtime validates ports and atomically queues one immutable payload per id', async t => {
  const directory = await workspace(t);
  const config = resolveConfig({ COACH_DATA_DIR: directory, COACH_PORT: '47835' });
  assert.throws(() => resolveConfig({ COACH_PORT: 'invalid' }));
  assert.throws(() => resolveConfig({ COACH_DATA_DIR: ROOT_DIR }), /代码目录之外/);
  assert.throws(() => resolveConfig({ COACH_DATA_DIR: path.join(ROOT_DIR, 'data') }), /代码目录之外/);
  const record = capture();
  await Promise.all([queueCapture(config, record), queueCapture(config, record)]);
  assert.deepEqual(JSON.parse(await readFile(path.join(config.outboxDir, `${record.id}.json`), 'utf8')), record);
  assert.deepEqual(await readdir(config.outboxDir), [`${record.id}.json`]);
  await assert.rejects(queueCapture(config, { ...record, sourceLabel: 'changed' }), /不同内容/);
});

test('runtime refuses an unrelated service without stopping or replacing it', async t => {
  const directory = await workspace(t);
  const server = createHttpServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ product: 'someone-else' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = resolveConfig({ COACH_DATA_DIR: directory, COACH_PORT: String(server.address().port) });
  await assert.rejects(ensureBackend(config), BackendConflictError);
  await assert.rejects(stopBackend(config), BackendConflictError);
  assert.equal((await fetch(config.baseUrl)).status, 200);
});

test('capture delivery checks the data directory even when automatic startup is disabled', async t => {
  const directory = await workspace(t);
  const port = String(await unusedPort());
  const first = resolveConfig({ COACH_DATA_DIR: path.join(directory, 'first'), COACH_PORT: port });
  const second = resolveConfig({ COACH_DATA_DIR: path.join(directory, 'second'), COACH_PORT: port });
  backends.get(t).push(second);
  await ensureBackend(second);
  const input = capture();
  const result = await deliverCapture(first, input, { autoStart: false });
  assert.equal(result.status, 'queued');
  assert.deepEqual(JSON.parse(await readFile(path.join(first.outboxDir, `${input.id}.json`), 'utf8')), input);
  assert.equal((await fetch(`${second.baseUrl}/api/stats`).then(response => response.json())).total, 0);
});

test('parallel starters share a backend; offline captures import once and survive restart', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const config = resolveConfig({ COACH_DATA_DIR: directory, COACH_PORT: String(await unusedPort()) });
  backends.get(t).push(config);
  const record = capture();
  const queued = await deliverCapture(config, record, { autoStart: false });
  assert.equal(queued.status, 'queued');
  const started = await Promise.all(Array.from({ length: 4 }, () => ensureBackend(config)));
  assert.equal(new Set(started.map(value => value.instanceId)).size, 1);
  await until(async () => (await fetch(`${config.baseUrl}/api/stats`).then(value => value.json())).total === 1);
  await until(async () => !(await readdir(config.outboxDir)).includes(`${record.id}.json`));
  const repeated = await deliverCapture(config, record);
  assert.equal(repeated.status, 'saved');
  assert.equal(repeated.replayed, true);
  const cards = await fetch(`${config.baseUrl}/api/cards`).then(value => value.json());
  assert.equal(cards.total, 1);
  assert.equal(cards.items[0].encounters, 1);
  const otherData = resolveConfig({ COACH_DATA_DIR: path.join(directory, 'other'), COACH_PORT: String(config.port) });
  await assert.rejects(health(otherData), BackendConflictError);
  await stopBackend(config);
  await ensureBackend(config);
  assert.equal((await fetch(`${config.baseUrl}/api/stats`).then(value => value.json())).total, 1);
});

test('managed guidance rejects unmatched markers and preserves unrelated content', () => {
  const original = '# Existing instructions\nKeep the project policy.\n';
  const managed = '<!-- codex-english-coach:start -->\nOur policy\n<!-- codex-english-coach:end -->\n';
  assert.equal(stripManagedBlock(`${original}${managed}`), original);
  assert.throws(() => stripManagedBlock(`${original}<!-- codex-english-coach:start -->`), /不完整/);
  assert.throws(() => stripManagedBlock('<!-- codex-english-coach:end --><!-- codex-english-coach:start -->'), /顺序错误/);
  assert.throws(() => stripManagedBlock('<!-- codex-english-coach:start --><!-- codex-english-coach:start --><!-- codex-english-coach:end --><!-- codex-english-coach:end -->'), /顺序错误/);
});

test('isolated install is repeatable and uninstall keeps learning data and unrelated configuration', { timeout: 40000 }, async t => {
  const directory = await workspace(t);
  const codexHome = path.join(directory, 'Codex home with spaces');
  const dataDir = path.join(directory, 'Learning data');
  const port = await unusedPort();
  const config = resolveConfig({ COACH_DATA_DIR: dataDir, COACH_PORT: String(port) });
  await mkdir(codexHome, { recursive: true });
  const guidance = '# Existing global rules\nPreserve this text.\n';
  const baseGuidance = 'Base instructions must stay untouched.\n';
  await writeFile(path.join(codexHome, 'AGENTS.override.md'), guidance);
  await writeFile(path.join(codexHome, 'AGENTS.md'), baseGuidance);
  await writeFile(path.join(codexHome, 'config.toml'), '[mcp_servers.other]\ncommand = "other-program"\n');
  const fake = await fakeCodex(directory);
  const env = { COACH_CODEX_COMMAND: process.execPath, COACH_CODEX_ARGS: JSON.stringify([fake]), COACH_DATA_DIR: dataDir, COACH_PORT: String(port) };
  backends.get(t).push(config);
  const args = ['install', '--skip-build', '--codex-home', codexHome];
  const first = await cli(args, env);
  assert.equal(first.code, 0, first.stderr);
  await deliverCapture(config, capture());
  const second = await cli(args, env);
  assert.equal(second.code, 0, second.stderr);
  const installed = await readFile(path.join(codexHome, 'AGENTS.override.md'), 'utf8');
  const third = await cli(args, env);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(await readFile(path.join(codexHome, 'AGENTS.override.md'), 'utf8'), installed);
  assert.equal(installed.split('<!-- codex-english-coach:start -->').length - 1, 1);
  assert.ok(installed.startsWith(guidance));
  assert.equal(await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8'), baseGuidance);
  const mcp = JSON.parse(await readFile(path.join(codexHome, 'mock-mcp.json'), 'utf8'));
  assert.equal(mcp.transport.env.COACH_DATA_DIR, dataDir);
  assert.equal(mcp.transport.command, process.execPath);
  assert.equal((await fetch(`${config.baseUrl}/api/stats`).then(value => value.json())).total, 1);
  const removed = await cli(['uninstall', '--codex-home', codexHome], env);
  assert.equal(removed.code, 0, removed.stderr);
  assert.ok((await readFile(path.join(codexHome, 'AGENTS.override.md'), 'utf8')).includes(guidance.trim()));
  assert.equal(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), '[mcp_servers.other]\ncommand = "other-program"\n');
  assert.ok((await readdir(dataDir)).some(value => /\.sqlite$/.test(value)));
  await ensureBackend(config);
  assert.equal((await fetch(`${config.baseUrl}/api/stats`).then(value => value.json())).total, 1);
});

test('installation preserves unrelated skills and MCP names instead of overwriting them', { timeout: 15000 }, async t => {
  const directory = await workspace(t);
  const codexHome = path.join(directory, 'codex');
  const dataDir = path.join(directory, 'data');
  const fake = await fakeCodex(directory);
  const env = { COACH_CODEX_COMMAND: process.execPath, COACH_CODEX_ARGS: JSON.stringify([fake]), COACH_DATA_DIR: dataDir, COACH_PORT: String(await unusedPort()) };
  const skill = path.join(codexHome, 'skills', 'codex-english-coach');
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), 'An unrelated user skill');
  const args = ['install', '--skip-build', '--codex-home', codexHome];
  const blockedSkill = await cli(args, env);
  assert.equal(blockedSkill.code, 1);
  assert.match(blockedSkill.stderr, /同名技能不属于本项目/);
  assert.equal(await readFile(path.join(skill, 'SKILL.md'), 'utf8'), 'An unrelated user skill');
  await rm(skill, { recursive: true });
  const originalMcp = JSON.stringify({ name: 'codex-english-coach', transport: { command: 'other-app', args: ['other-script'] } });
  await writeFile(path.join(codexHome, 'mock-mcp.json'), originalMcp);
  const blockedMcp = await cli(args, env);
  assert.equal(blockedMcp.code, 1);
  assert.match(blockedMcp.stderr, /同名 MCP 不属于本项目/);
  assert.equal(await readFile(path.join(codexHome, 'mock-mcp.json'), 'utf8'), originalMcp);
});

test('one Codex home cannot be overwritten by another data directory and stale uninstall preserves the current integration', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const codexHome = path.join(directory, 'codex');
  const dataDir = path.join(directory, 'first-data');
  const config = resolveConfig({ COACH_DATA_DIR: dataDir, COACH_PORT: String(await unusedPort()) });
  backends.get(t).push(config);
  const fake = await fakeCodex(directory);
  const env = { COACH_CODEX_COMMAND: process.execPath, COACH_CODEX_ARGS: JSON.stringify([fake]), COACH_DATA_DIR: dataDir, COACH_PORT: String(config.port) };
  const args = ['install', '--skip-build', '--codex-home', codexHome];
  assert.equal((await cli(args, env)).code, 0);
  const mcpFile = path.join(codexHome, 'mock-mcp.json');
  const originalMcp = await readFile(mcpFile, 'utf8');
  const second = await cli(args, { ...env, COACH_DATA_DIR: path.join(directory, 'other-data'), COACH_PORT: String(await unusedPort()) });
  assert.equal(second.code, 1);
  assert.equal(await readFile(mcpFile, 'utf8'), originalMcp);
  const altered = JSON.parse(originalMcp);
  altered.transport.env.COACH_DATA_DIR = path.join(directory, 'other-data');
  await writeFile(mcpFile, JSON.stringify(altered));
  const stale = await cli(['uninstall', '--codex-home', codexHome], env);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /不匹配/);
  assert.ok((await readFile(path.join(codexHome, 'skills', 'codex-english-coach', 'SKILL.md'), 'utf8')).includes('codex-english-coach'));
  assert.ok((await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8')).includes('codex-english-coach:start'));
  await writeFile(mcpFile, originalMcp);
});

test('reinstalling with a new port moves only the same installation and preserves its cards', { timeout: 30000 }, async t => {
  const directory = await workspace(t);
  const codexHome = path.join(directory, 'codex');
  const dataDir = path.join(directory, 'data');
  const original = resolveConfig({ COACH_DATA_DIR: dataDir, COACH_PORT: String(await unusedPort()) });
  const updated = resolveConfig({ COACH_DATA_DIR: dataDir, COACH_PORT: String(await unusedPort()) });
  backends.get(t).push(original, updated);
  const fake = await fakeCodex(directory);
  const env = { COACH_CODEX_COMMAND: process.execPath, COACH_CODEX_ARGS: JSON.stringify([fake]), COACH_DATA_DIR: dataDir, COACH_PORT: String(original.port) };
  const args = ['install', '--skip-build', '--codex-home', codexHome];
  assert.equal((await cli(args, env)).code, 0);
  await deliverCapture(original, capture());
  const moved = await cli([...args, '--port', String(updated.port)], env);
  assert.equal(moved.code, 0, moved.stderr);
  assert.equal(await health(original), null);
  assert.equal((await fetch(`${updated.baseUrl}/api/stats`).then(response => response.json())).total, 1);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'installation.json'), 'utf8')).port, updated.port);
});

test('Windows npm-installed Codex is launched through its JS entry without invoking a shell', { timeout: 15000, skip: process.platform !== 'win32' }, async t => {
  const directory = await workspace(t);
  const prefix = path.join(directory, 'npm prefix');
  const packageDirectory = path.join(prefix, 'node_modules', '@openai', 'codex');
  const fake = await fakeCodex(directory);
  await mkdir(path.join(packageDirectory, 'bin'), { recursive: true });
  await cp(fake, path.join(packageDirectory, 'bin', 'codex.js'));
  await writeFile(path.join(packageDirectory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(prefix, 'codex.cmd'), 'This shim must never be executed by a shell.');
  const codexHome = path.join(directory, 'codex');
  const dataDir = path.join(directory, 'data');
  const port = await unusedPort();
  const config = resolveConfig({ COACH_DATA_DIR: dataDir, COACH_PORT: String(port) });
  backends.get(t).push(config);
  const env = {
    PATH: `${prefix}${path.delimiter}${process.env.PATH}`,
    COACH_CODEX_COMMAND: '', COACH_CODEX_ARGS: '[]', COACH_DATA_DIR: dataDir, COACH_PORT: String(port)
  };
  const installed = await cli(['install', '--skip-build', '--codex-home', codexHome], env);
  assert.equal(installed.code, 0, installed.stderr);
  const removed = await cli(['uninstall', '--codex-home', codexHome], env);
  assert.equal(removed.code, 0, removed.stderr);
});

test('a fast-forward update backs up SQLite and preserves records through a real temporary Git remote', { timeout: 60000 }, async t => {
  const directory = await workspace(t);
  const seed = path.join(directory, 'source');
  const origin = path.join(directory, 'origin.git');
  const application = path.join(directory, 'installed application');
  const codexHome = path.join(directory, 'codex');
  const dataDir = path.join(directory, 'data');
  await mkdir(seed, { recursive: true });
  const isolatedGitConfig = path.join(directory, 'empty-gitconfig');
  await writeFile(isolatedGitConfig, '');
  const gitEnv = {
    GIT_CONFIG_GLOBAL: isolatedGitConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
  };
  const git = async (args, cwd = seed) => {
    const result = await execute('git', args, cwd, gitEnv);
    assert.equal(result.code, 0, result.stderr);
    return result;
  };
  for (const relative of ['scripts', 'apps/server/dist', 'apps/web/dist', 'packages/mcp/dist', 'skills']) {
    await mkdir(path.dirname(path.join(seed, relative)), { recursive: true });
    await cp(path.join(ROOT_DIR, relative), path.join(seed, relative), { recursive: true });
  }
  await writeFile(path.join(seed, '.gitignore'), 'node_modules/\n');
  await git(['init', '--bare', '--initial-branch=main', origin], directory);
  await git(['init', '--initial-branch=main']);
  await git(['add', '.']);
  await git(['commit', '-m', 'Fixture version one']);
  await git(['remote', 'add', 'origin', origin]);
  await git(['push', '-u', 'origin', 'main']);
  await git(['clone', origin, application], directory);
  await symlink(path.join(ROOT_DIR, 'node_modules'), path.join(application, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const fake = await fakeCodex(directory);
  const port = await unusedPort();
  const env = { ...gitEnv, COACH_CODEX_COMMAND: process.execPath, COACH_CODEX_ARGS: JSON.stringify([fake]), COACH_DATA_DIR: dataDir, COACH_PORT: String(port) };
  const config = { ...resolveConfig(env), rootDir: application };
  backends.get(t).push(config);
  const first = await cli(['install', '--skip-build', '--codex-home', codexHome], env, application);
  assert.equal(first.code, 0, first.stderr);
  await deliverCapture(config, capture());
  await writeFile(path.join(seed, 'UPGRADE_MARKER'), 'version two\n');
  await git(['add', 'UPGRADE_MARKER']);
  await git(['commit', '-m', 'Fixture version two']);
  await git(['push']);
  const updated = await cli(['update', '--skip-build', '--codex-home', codexHome], env, application);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal(await readFile(path.join(application, 'UPGRADE_MARKER'), 'utf8'), 'version two\n');
  assert.ok((await readdir(path.join(dataDir, 'backups'))).some(name => name.endsWith('.sqlite')));
  assert.equal((await fetch(`${config.baseUrl}/api/stats`).then(value => value.json())).total, 1);
  const removed = await cli(['uninstall', '--codex-home', codexHome], env, application);
  assert.equal(removed.code, 0, removed.stderr);
});
