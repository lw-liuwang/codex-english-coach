import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile, lstat, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ROOT_DIR, PRODUCT, resolveConfig, ensureBackend, health, stopBackend } from './runtime.mjs';

const NAME = PRODUCT;
const START = '<!-- codex-english-coach:start -->';
const END = '<!-- codex-english-coach:end -->';
const OWNER = '.codex-english-coach-owned.json';
const manifestFile = config => path.join(config.dataDir, 'installation.json');

function parseArguments(args) {
  const command = args.shift() || 'help';
  const options = {};
  if (command === '--help' || command === '-h') return { command: 'help', options };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--skip-build') { options.skipBuild = true; continue; }
    if (flag === '--help' || flag === '-h') return { command: 'help', options };
    if (!['--codex-home', '--data-dir', '--port'].includes(flag)) throw new Error(`未知参数：${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${flag} 需要一个值。`);
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

export function stripManagedBlock(contents) {
  const starts = contents.split(START).length - 1;
  const ends = contents.split(END).length - 1;
  const pattern = /<!-- codex-english-coach:start -->[\s\S]*?<!-- codex-english-coach:end -->\r?\n?/g;
  if (starts !== ends || [...contents.matchAll(pattern)].length !== starts) throw new Error('个人指令中的 English Coach 标记不完整或顺序错误，请先修复标记。');
  return contents.replace(pattern, '');
}

function guidanceBlock(skillDir) {
  return `${START}\n## Codex English Coach\n\n` +
    `Default to English collaboration in all chats. Load ${JSON.stringify(path.join(skillDir, 'SKILL.md'))} for the writing, reading, and ${NAME} MCP recording workflow. Keep the user's actual task moving.\n` +
    `The user's current instructions take priority. “赶时间” or “暂停英语协作” pauses teaching and capture in this chat; “恢复英语协作” resumes. Include a short Chinese explanation for important decisions.\n${END}\n`;
}

async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, filename);
}

async function readText(filename) {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function readManifest(config) {
  const raw = await readText(manifestFile(config));
  if (!raw) return null;
  const manifest = JSON.parse(raw);
  if (manifest.product !== PRODUCT || manifest.schemaVersion !== 1) throw new Error('安装记录不属于本项目或版本不兼容，已停止修改。');
  return manifest;
}

async function run(command, args, { env = process.env, cwd = ROOT_DIR, allowFailure = false, visible = false } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (visible) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; if (visible) process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
  if (result.code && !allowFailure) throw new Error(`${path.basename(command)} ${args[0] || ''} 失败：${(result.stderr || result.stdout).trim().slice(0, 1600)}`);
  return result;
}

function codexInvocation() {
  let args;
  try { args = JSON.parse(process.env.COACH_CODEX_ARGS || '[]'); }
  catch { throw new Error('COACH_CODEX_ARGS 必须为 JSON 字符串数组。'); }
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('COACH_CODEX_ARGS 必须为 JSON 字符串数组。');
  if (process.env.COACH_CODEX_COMMAND) return { command: process.env.COACH_CODEX_COMMAND, args };
  if (process.platform === 'win32') {
    for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const executable = path.join(directory, 'codex.exe');
      if (existsSync(executable)) return { command: executable, args };
      const npmEntry = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(path.join(directory, 'codex.cmd')) && existsSync(npmEntry)) {
        // Node cannot spawn a .cmd shim without a shell; execute its JS entry directly instead.
        return { command: process.execPath, args: [npmEntry, ...args] };
      }
    }
  }
  return { command: 'codex', args };
}

async function runCodex(args, codexHome, options = {}) {
  const invocation = codexInvocation();
  return run(invocation.command, [...invocation.args, ...args], { ...options, env: { ...process.env, CODEX_HOME: codexHome } });
}

async function npm(args) {
  const entry = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(entry)) throw new Error('找不到 npm CLI，请使用包含 npm 的 Node.js 24 安装。');
  await run(process.execPath, [entry, ...args], { visible: true });
}

async function getMcp(codexHome) {
  const result = await runCodex(['mcp', 'get', NAME, '--json'], codexHome, { allowFailure: true });
  if (result.code) {
    if (/No MCP server|not found|does not exist|No server named/i.test(result.stderr + result.stdout)) return null;
    throw new Error(`无法检查已有 MCP 配置：${(result.stderr || result.stdout).trim()}`);
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Codex 返回了无法识别的 MCP 配置，已停止修改。'); }
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function ownsMcp(mcp, installation) {
  const transport = mcp?.transport || mcp;
  const args = transport?.args;
  return samePath(transport?.command, process.execPath) && Array.isArray(args) &&
    args.some(value => samePath(value, path.join(installation.rootDir, 'packages', 'mcp', 'dist', 'main.js'))) &&
    samePath(transport.env?.COACH_DATA_DIR, installation.dataDir) && Number(transport.env?.COACH_PORT) === installation.port;
}

async function preflight(codexHome) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('请先安装 Node.js 24 LTS（包含 npm），再运行安装器。');
  await run('git', ['--version']);
  await mkdir(codexHome, { recursive: true });
  await runCodex(['--version'], codexHome);
}

async function checkSkillOwnership(skillDir, installation) {
  if (!existsSync(skillDir)) return;
  if ((await lstat(skillDir)).isSymbolicLink()) throw new Error(`技能目录是符号链接，请先选择独立目录：${skillDir}`);
  let owner;
  try { owner = JSON.parse(await readText(path.join(skillDir, OWNER))); } catch { /* An unrelated skill has no ownership marker. */ }
  if (owner?.product !== PRODUCT) throw new Error(`已有同名技能不属于本项目，已保留原内容：${skillDir}`);
  if (!samePath(owner.dataDir, installation.dataDir) || !samePath(owner.rootDir, installation.rootDir)) {
    throw new Error('同名技能属于另一份安装，已保留原内容。请先卸载原安装。');
  }
}

async function activeGuidance(codexHome) {
  const override = path.join(codexHome, 'AGENTS.override.md');
  return (await readText(override)).trim() ? override : path.join(codexHome, 'AGENTS.md');
}

export async function install(config, { codexHome, skipBuild = false } = {}) {
  codexHome = path.resolve(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  await preflight(codexHome);
  const previous = await readManifest(config);
  if (previous && path.resolve(previous.codexHome) !== codexHome) throw new Error('同一数据目录已有其他 CODEX_HOME 的安装，请使用独立数据目录。');
  const existingMcp = await getMcp(codexHome);
  const previousIdentity = previous || config;
  if (existingMcp && !ownsMcp(existingMcp, previousIdentity)) throw new Error(`已有同名 MCP 不属于本项目的这份安装，已保留：${NAME}`);
  stripManagedBlock(await readText(await activeGuidance(codexHome)));
  const skillDir = path.join(codexHome, 'skills', NAME);
  await checkSkillOwnership(skillDir, previousIdentity);
  const source = path.join(config.rootDir, 'skills', NAME);
  if (!existsSync(path.join(source, 'SKILL.md'))) throw new Error('项目中的 SKILL.md 不存在，请确认获取了完整代码。');
  if (!skipBuild) { await npm(['ci']); await npm(['run', 'build']); }
  const mcpEntry = path.join(config.rootDir, 'packages', 'mcp', 'dist', 'main.js');
  if (!existsSync(mcpEntry) || !existsSync(path.join(config.rootDir, 'apps', 'web', 'dist', 'index.html'))) throw new Error('构建产物不完整，请运行 npm run build。');
  if (previous && previous.port !== config.port) {
    await stopBackend({ ...config, port: previous.port, baseUrl: `http://127.0.0.1:${previous.port}` });
  }
  await ensureBackend(config);
  await mkdir(path.dirname(skillDir), { recursive: true });
  await cp(source, skillDir, { recursive: true, force: true });
  await atomicJson(path.join(skillDir, OWNER), { product: PRODUCT, rootDir: config.rootDir, dataDir: config.dataDir });
  await runCodex(['mcp', 'add', NAME, '--env', `COACH_DATA_DIR=${config.dataDir}`, '--env', `COACH_PORT=${config.port}`, '--', process.execPath, mcpEntry], codexHome);
  const guidancePath = await activeGuidance(codexHome);
  const manifest = {
    product: PRODUCT, schemaVersion: 1, rootDir: config.rootDir, codexHome,
    skillDir, guidancePath, dataDir: config.dataDir, port: config.port, installedAt: new Date().toISOString()
  };
  // Keep enough ownership information to undo a partially completed installation.
  await atomicJson(manifestFile(config), manifest);
  if (previous?.guidancePath && previous.guidancePath !== guidancePath) {
    const old = await readText(previous.guidancePath);
    if (old.includes(START)) await writeFile(previous.guidancePath, stripManagedBlock(old), 'utf8');
  }
  const original = await readText(guidancePath);
  const rest = stripManagedBlock(original);
  await writeFile(guidancePath, `${rest}${rest.endsWith('\n') || !rest ? '' : '\n'}${guidanceBlock(skillDir)}`, 'utf8');
  return manifest;
}

export async function uninstall(config, { codexHome } = {}) {
  const manifest = await readManifest(config);
  if (!manifest) throw new Error('没有找到本项目安装记录，未修改 Codex 配置。');
  if (codexHome && path.resolve(codexHome) !== path.resolve(manifest.codexHome)) throw new Error('指定的 CODEX_HOME 与安装记录不一致。');
  const mcp = await getMcp(manifest.codexHome);
  if (mcp && !ownsMcp(mcp, manifest)) throw new Error('当前 MCP 与这份安装记录不匹配，已保留现有集成。');
  const expected = path.join(manifest.codexHome, 'skills', NAME);
  if (!samePath(manifest.skillDir, expected)) throw new Error('技能路径与安装记录不一致，已停止删除。');
  await checkSkillOwnership(manifest.skillDir, manifest);
  const contents = await readText(manifest.guidancePath);
  const remainingGuidance = stripManagedBlock(contents);
  await stopBackend(config);
  if (mcp) await runCodex(['mcp', 'remove', NAME], manifest.codexHome);
  if (existsSync(manifest.skillDir)) {
    await rm(manifest.skillDir, { recursive: true });
  }
  if (contents.includes(START)) await writeFile(manifest.guidancePath, remainingGuidance, 'utf8');
  await rm(manifestFile(config));
  return { dataDir: config.dataDir };
}

async function update(config, options) {
  const manifest = await readManifest(config);
  if (!manifest) throw new Error('请先安装项目，再执行更新。');
  const changes = await run('git', ['status', '--porcelain']);
  if (changes.stdout.trim()) throw new Error('项目有未提交的改动，已停止更新；请先保存这些改动。');
  await ensureBackend(config);
  const response = await fetch(`${config.baseUrl}/api/system/backup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!response.ok) throw new Error('数据库备份失败，已停止更新。');
  const saved = await response.json();
  process.stdout.write(`已备份数据库：${saved.path}\n`);
  await stopBackend(config);
  await run('git', ['pull', '--ff-only'], { visible: true });
  return install(config, { codexHome: options.codexHome || manifest.codexHome, skipBuild: options.skipBuild });
}

async function doctor(config, codexHome) {
  const manifest = await readManifest(config);
  const actualHome = codexHome || manifest?.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const info = await health(config);
  const mcp = await getMcp(actualHome);
  const checks = {
    'Node.js 24': Number(process.versions.node.split('.')[0]) === 24,
    '安装记录': Boolean(manifest),
    'Skill': Boolean(manifest && existsSync(path.join(manifest.skillDir, 'SKILL.md'))),
    'MCP 注册': Boolean(mcp && ownsMcp(mcp, manifest || config)),
    '全局启用规则': Boolean(manifest && (await readText(manifest.guidancePath)).includes(START)),
    '本地服务': Boolean(info)
  };
  for (const [name, passed] of Object.entries(checks)) process.stdout.write(`${passed ? '✓' : '✗'} ${name}\n`);
  process.stdout.write(`网页：${config.baseUrl}\n数据：${config.dataDir}\n`);
  return Object.values(checks).every(Boolean);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  let config = resolveConfig({ ...process.env, ...(options['data-dir'] ? { COACH_DATA_DIR: options['data-dir'] } : {}), ...(options.port ? { COACH_PORT: options.port } : {}) });
  if (!options.port && !process.env.COACH_PORT) {
    const installed = await readManifest(config);
    if (installed?.port) config = { ...config, port: installed.port, baseUrl: `http://127.0.0.1:${installed.port}` };
  }
  const context = { codexHome: options['codex-home'], skipBuild: options.skipBuild };
  if (command === 'install' || command === 'update') {
    const manifest = command === 'install' ? await install(config, context) : await update(config, context);
    process.stdout.write(`安装完成。\n网页：${config.baseUrl}\n数据：${config.dataDir}\n技能：${manifest.skillDir}\n请重新加载 MCP 或重启 Codex，并在新聊天中验证英语协作和 capture_learning 工具。\n`);
  } else if (command === 'start') {
    await ensureBackend(config); process.stdout.write(`复习网页：${config.baseUrl}\n`);
  } else if (command === 'stop') {
    const stopped = await stopBackend(config); process.stdout.write(stopped ? '本地服务已停止。\n' : '本地服务尚未运行。\n');
  } else if (command === 'uninstall') {
    const result = await uninstall(config, context); process.stdout.write(`已卸载 Codex 集成并停止服务。学习记录保留在：${result.dataDir}\n项目代码可在确认不再使用后自行移除。\n`);
  } else if (command === 'doctor') {
    if (!(await doctor(config, context.codexHome))) process.exitCode = 1;
  } else if (command === 'help') {
    process.stdout.write('Codex English Coach\n\nnode scripts/cli.mjs <install|start|stop|doctor|update|uninstall>\n\n可选参数：--codex-home <目录> --data-dir <目录> --port <端口>\ninstall/update 可使用 --skip-build 复用已验证的构建产物。\n');
  } else throw new Error(`未知命令：${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`English Coach：${error.message}\n`); process.exitCode = 1; });
}
