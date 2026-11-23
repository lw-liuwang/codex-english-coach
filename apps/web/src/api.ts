export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  if (!response.ok) {
    let message = `请求未完成（${response.status}），请稍后再试。`;
    try {
      const body = await response.json() as { message?: string; error?: string };
      message = body.message || body.error || message;
    } catch { /* Keep the status message when the response is not JSON. */ }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof TypeError) return '暂时无法连接，请确认本地服务正在运行后重试。';
  return error instanceof Error ? error.message : '连接未完成，请确认本地服务正在运行。';
}

export function dateLabel(value: string, includeTime = false): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {})
  }).format(new Date(value.length === 10 ? `${value}T00:00:00+08:00` : value));
}
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
