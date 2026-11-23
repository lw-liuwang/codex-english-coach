export interface RuntimeConfig { rootDir: string; dataDir: string; port: number; baseUrl: string; outboxDir: string }
export const ROOT_DIR: string;
export const PRODUCT: string;
export const PROTOCOL_VERSION: number;
export class BackendConflictError extends Error {}
export function resolveConfig(env?: NodeJS.ProcessEnv): RuntimeConfig;
export function health(config: RuntimeConfig): Promise<import('@english-coach/shared').Health | null>;
export function ensureBackend(config: RuntimeConfig): Promise<import('@english-coach/shared').Health>;
export function stopBackend(config: RuntimeConfig): Promise<boolean>;
export function queueCapture(config: RuntimeConfig, capture: import('@english-coach/shared').CaptureInput): Promise<string>;
export function deliverCapture(config: RuntimeConfig, capture: import('@english-coach/shared').CaptureInput, options?: { autoStart?: boolean }): Promise<import('@english-coach/shared').CaptureResult | { id: string; status: 'queued'; message: string; queuedPath: string }>;
