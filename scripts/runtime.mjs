import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, open, link, unlink, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCT = 'codex-english-coach';
export const PROTOCOL_VERSION = 1;

export function resolveConfig(env = process.env) {
  const defaultData = process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexEnglishCoach')
    : path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'codex-english-coach');
  const dataDir = path.resolve(env.COACH_DATA_DIR || defaultData);
  const relativeData = path.relative(ROOT_DIR, dataDir);
  if (relativeData === '' || (!relativeData.startsWith(`..${path.sep}`) && relativeData !== '..' && !path.isAbsolute(relativeData))) {
    throw new Error('学习数据目录必须位于项目代码目录之外。');
  }
  const port = Number(env.COACH_PORT || '47831');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COACH_PORT 必须为 1 到 65535 之间的端口。');
  return { rootDir: ROOT_DIR, dataDir, port, baseUrl: `http://127.0.0.1:${port}`, outboxDir: path.join(dataDir, 'outbox') };
}

function samePath(left, right) {
  const normalize = value => {
    const absolute = path.resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

export class BackendConflictError extends Error {}

export async function health(config) {
  let response;
  try {
    response = await fetch(`${config.baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return null;
  }
  let info;
  try { info = await response.json(); }
  catch { throw new BackendConflictError(`端口 ${config.port} 已被其他服务占用。`); }
  if (!response.ok || info.product !== PRODUCT || info.protocolVersion !== PROTOCOL_VERSION || info.status !== 'ok') {
    throw new BackendConflictError(`端口 ${config.port} 的服务不是兼容的 Codex English Coach。`);
  }
  if (typeof info.dataDir !== 'string' || !samePath(info.dataDir, config.dataDir)) {
    throw new BackendConflictError(`端口 ${config.port} 正在使用其他学习数据目录。请为另一个实例选择不同端口。`);
  }
  return info;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForExit(pid, milliseconds = 4000) {
  if (!pid || pid === process.pid) return;
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(50);
  }
  throw new Error(`进程 ${pid} 尚未退出，请稍后重试。`);
}

async function acceptWinner(info, child) {
  if (child.pid !== info.pid && child.exitCode === null) {
    // A competing launch may still have a database handle open while it loses the port race.
    child.kill();
    await waitForExit(child.pid);
  }
  return info;
}

export async function ensureBackend(config) {
  const running = await health(config);
  if (running) return running;
  const entry = path.join(config.rootDir, 'apps', 'server', 'dist', 'main.js');
  if (!existsSync(entry)) throw new Error('后端尚未构建，请先运行 npm run build。');
  await mkdir(path.join(config.dataDir, 'logs'), { recursive: true });
  const log = openSync(path.join(config.dataDir, 'logs', 'server.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [entry], {
      cwd: config.rootDir,
      env: { ...process.env, COACH_DATA_DIR: config.dataDir, COACH_PORT: String(config.port) },
      detached: true, windowsHide: true, stdio: ['ignore', log, log]
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { closeSync(log); }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const info = await health(config);
    if (info) return acceptWinner(info, child);
    // A losing process can exit before the winning launcher becomes healthy.
    // Keep the same readiness deadline for all launchers instead of failing that chat early.
    await delay(100);
  }
  const exited = child.exitCode !== null;
  if (!exited && child.pid) { try { child.kill(); } catch { /* The child may already have exited. */ } }
  throw new Error(`后端${exited ? '启动失败' : '启动超时'}，请检查端口 ${config.port} 是否可用，或查看 ${path.join(config.dataDir, 'logs', 'server.log')}`);
}

export async function stopBackend(config) {
  const info = await health(config);
  if (!info) return false;
  const response = await fetch(`${config.baseUrl}/api/system/shutdown`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: info.instanceId }), signal: AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`停止后端失败：HTTP ${response.status}`);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await health(config))) { await waitForExit(info.pid); return true; }
    await delay(100);
  }
  throw new Error('后端尚未退出，请稍后重试。');
}

export async function queueCapture(config, capture) {
  await mkdir(config.outboxDir, { recursive: true });
  const destination = path.join(config.outboxDir, `${capture.id}.json`);
  const temporary = path.join(config.outboxDir, `.${capture.id}.${randomUUID()}.tmp`);
  const contents = JSON.stringify(capture);
  const file = await open(temporary, 'wx');
  try { await file.writeFile(contents, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // Linking a fully written file makes it visible to the importer atomically.
        await link(temporary, destination);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let existing;
        try { existing = await readFile(destination, 'utf8'); }
        catch (readError) {
          // The backend can finish importing the existing file between link and read.
          if (readError.code === 'ENOENT' && attempt < 3) continue;
          throw readError;
        }
        if (existing !== contents) throw new Error('同一记录编号对应了不同内容，请使用新的编号。');
        break;
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }
  return destination;
}

export async function deliverCapture(config, capture, { autoStart = true } = {}) {
  const queuedPath = await queueCapture(config, capture);
  try {
    if (autoStart) await ensureBackend(config);
    else if (!(await health(config))) throw new Error('本地后端尚未运行。');
    const response = await fetch(`${config.baseUrl}/api/captures`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(capture),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`HTTP ${response.status}: ${detail.slice(0, 400)}`);
      if (response.status >= 400 && response.status < 500) error.rejected = true;
      throw error;
    }
    const result = await response.json();
    await unlink(queuedPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return result;
  } catch (error) {
    if (error.rejected) {
      const failed = path.join(config.outboxDir, 'failed');
      await mkdir(failed, { recursive: true });
      await rename(queuedPath, path.join(failed, `${capture.id}.json`)).catch(moveError => { if (moveError.code !== 'ENOENT') throw moveError; });
      throw new Error(`后端拒绝了学习记录，已保留失败条目供检查：${error.message}`);
    }
    return { id: capture.id, status: 'queued', message: `待同步：${error.message}`, queuedPath };
  }
}
