import { resolveConfig } from '../../../scripts/runtime.mjs';
import { buildServer } from './app.js';

const config = resolveConfig();
const app = await buildServer({
  dataDir: config.dataDir,
  logger: true,
  onShutdown: async () => { await app.close(); }
});
process.once('SIGINT', () => { void app.close(); });
process.once('SIGTERM', () => { void app.close(); });
try {
  await app.listen({ host: '127.0.0.1', port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
