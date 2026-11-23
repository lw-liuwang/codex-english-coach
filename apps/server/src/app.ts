import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  CardPatchSchema, CaptureInputSchema, KindSchema, MAX_CAPTURE_BYTES, PRODUCT, PROTOCOL_VERSION,
  ReviewInputSchema, SourceSchema, VERSION, type Health
} from '@english-coach/shared';
import { LearningStore, StoreError, type CardFilters } from './database.js';

export interface ServerOptions {
  dataDir: string;
  now?: () => Date;
  logger?: boolean;
  webRoot?: string;
  onShutdown?: () => void | Promise<void>;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function integer(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new StoreError(400, '分页参数必须是整数。');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new StoreError(400, '分页参数超出范围。');
  return result;
}
function dateFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new StoreError(400, '日期格式应为 YYYY-MM-DD。');
  }
  return value;
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const dataDir = resolve(options.dataDir);
  const store = new LearningStore(dataDir, options.now);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_CAPTURE_BYTES });
  const instanceId = randomUUID();
  const outbox = join(dataDir, 'outbox');
  await mkdir(outbox, { recursive: true });

  async function pendingFiles() {
    return (await readdir(outbox)).filter(name => name.endsWith('.json'));
  }
  let flushing: Promise<void> | undefined;
  function flushPending(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      for (const name of await pendingFiles()) {
        const path = join(outbox, name);
        let input: ReturnType<typeof CaptureInputSchema.parse>;
        try {
          input = CaptureInputSchema.parse(JSON.parse(await readFile(path, 'utf8')));
          if (name !== `${input.id}.json`) throw new Error('Outbox filename does not match its capture ID');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          await mkdir(join(outbox, 'failed'), { recursive: true });
          await rename(path, join(outbox, 'failed', name)).catch(moveError => {
            if ((moveError as NodeJS.ErrnoException).code !== 'ENOENT') throw moveError;
          });
          app.log.warn({ file: name }, 'Invalid queued learning record was moved to outbox/failed');
          continue;
        }
        try {
          store.capture(input);
          await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        } catch (error) {
          if (error instanceof StoreError && error.statusCode === 409) {
            await mkdir(join(outbox, 'failed'), { recursive: true });
            await rename(path, join(outbox, 'failed', name)).catch(moveError => {
              if ((moveError as NodeJS.ErrnoException).code !== 'ENOENT') throw moveError;
            });
          } else app.log.error({ err: error, file: name }, 'Queued learning record could not be saved');
        }
      }
    })().finally(() => { flushing = undefined; });
    return flushing;
  }

  app.addHook('onRequest', async request => {
    const rawHost = request.headers.host;
    let allowedOrigin: string;
    try {
      if (!rawHost || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(rawHost)) throw new Error('host');
      const host = new URL(`http://${rawHost}`);
      allowedOrigin = host.origin;
      const address = app.server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      if (port !== null && Number(host.port || 80) !== port) throw new Error('port');
    } catch { throw new StoreError(403, '请通过本机地址访问此服务。'); }
    if (!request.headers.origin) return;
    try {
      const origin = new URL(request.headers.origin);
      if (origin.origin !== allowedOrigin) throw new Error('origin');
    } catch { throw new StoreError(403, '请从本机复习页面访问此接口。'); }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof StoreError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof Error && error.name === 'ZodError') return reply.code(400).send({ error: '请求字段不符合接口要求。', details: error.message });
    const failure = error instanceof Error ? error : new Error('Unknown server error');
    const statusCode = 'statusCode' in failure ? failure.statusCode : undefined;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    if (status === 500) request.log.error(error);
    return reply.code(status).send({ error: status === 500 ? '操作未完成，请查看本机服务日志。' : failure.message });
  });

  app.get('/api/health', async (): Promise<Health> => ({
    product: PRODUCT, protocolVersion: PROTOCOL_VERSION, version: VERSION, status: 'ok',
    pid: process.pid, instanceId, dataDir
  }));
  app.get('/api/stats', async () => store.stats((await pendingFiles()).length));
  app.post('/api/captures', async request => store.capture(CaptureInputSchema.parse(request.body)));
  app.get('/api/cards', async request => {
    const query = request.query as Record<string, unknown>;
    const filters: CardFilters = {
      limit: integer(query.limit, 50, 200, 1), offset: integer(query.offset, 0, 1000000),
      from: dateFilter(query.from), to: dateFilter(query.to)
    };
    if (filters.from && filters.to && filters.from > filters.to) throw new StoreError(400, '开始日期应早于或等于结束日期。');
    if (query.source !== undefined) filters.source = SourceSchema.parse(query.source);
    if (query.kind !== undefined) filters.kind = KindSchema.parse(query.kind);
    if (query.archived !== undefined && query.archived !== 'false' && query.archived !== 'true') throw new StoreError(400, '归档筛选值无效。');
    filters.archived = query.archived === 'true';
    if (query.q !== undefined) {
      if (typeof query.q !== 'string' || query.q.length > 300) throw new StoreError(400, '搜索内容应少于 300 字符。');
      filters.q = query.q.trim();
    }
    return store.list(filters);
  });
  app.get<{ Params: { id: string } }>('/api/cards/:id', async request => {
    if (!uuidPattern.test(request.params.id)) throw new StoreError(400, '卡片编号无效。');
    return store.detail(request.params.id);
  });
  app.patch<{ Params: { id: string } }>('/api/cards/:id', async request => {
    if (!uuidPattern.test(request.params.id)) throw new StoreError(400, '卡片编号无效。');
    return store.patch(request.params.id, CardPatchSchema.parse(request.body));
  });
  app.get('/api/reviews/queue', async request => {
    const query = request.query as Record<string, unknown>;
    return store.queue(integer(query.limit, 10, 50, 1), query.source === undefined ? undefined : SourceSchema.parse(query.source));
  });
  app.post('/api/reviews', async request => store.review(ReviewInputSchema.parse(request.body)));
  app.get('/api/export', async (_request, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="codex-english-coach.json"');
    return store.exportData();
  });
  app.post('/api/system/backup', async () => ({ path: await store.backup() }));
  app.post('/api/system/shutdown', async (request, reply) => {
    if ((request.body as { instanceId?: unknown } | null)?.instanceId !== instanceId) throw new StoreError(409, '服务实例已变化，请重新检查状态。');
    reply.send({ ok: true });
    setImmediate(() => { void options.onShutdown?.(); });
  });

  const webRoot = options.webRoot ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在。' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_request, reply) => reply.code(503).send({ error: '网页尚未构建，请运行 npm run build。' }));
  }
  await flushPending();
  const timer = setInterval(() => { void flushPending().catch(error => app.log.error(error)); }, 3000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); await flushing; store.close(); });
  return app;
}

export const createServer = buildServer;
