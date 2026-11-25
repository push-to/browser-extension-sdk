import { API_VERSION_PATH, CORE_URL } from './constants';
import { FeedbackEvent, RegisterEndpointBody, UpsertUserBody } from './types';

/**
 * A failed push-api call. `code`, `message` and `details` come from the
 * `{ "error": { code, message, details? } }` body. Two codes are the SDK's
 * own: `network_error` (no response; `status` is 0) and `http_error` (a
 * response without that body).
 */
export class PushToApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  }) {
    super(init.message);
    this.name = 'PushToApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
  }
}

/**
 * The `/v1` root for a host: `override` if given, else the build-time host.
 * Trailing slashes are dropped, and so is a `/v1` the caller already added.
 */
export function resolveApiBaseUrl(
  override?: string,
  fallback: string | undefined = CORE_URL,
): string {
  const picked = override?.trim() ? override : fallback;
  const host = (picked ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
    .replace(/\/+$/, '');

  let url: URL | undefined;
  try {
    url = new URL(host);
  } catch {
    // reported below
  }
  // The key travels in a header on every call: plain http is for a local
  // push-api only. A query or fragment would end up in the middle of the
  // request URLs.
  const valid =
    url !== undefined &&
    !url.search &&
    !url.hash &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopback(url.hostname)));
  if (!valid) {
    throw new Error(
      'PushNotifications: no valid API base URL. Pass `apiBaseUrl` (an https URL without /v1, query or fragment; http is accepted for localhost only) or build the package with PUSHTO_CORE_URL set.',
    );
  }
  return host + API_VERSION_PATH;
}

function isLoopback(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

/** `AbortSignal.timeout` is Chrome 103+; older ones go without a timeout. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function toApiError(response: Response): Promise<PushToApiError> {
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    // not JSON: reported as http_error below
  }
  const error =
    envelope && typeof envelope === 'object'
      ? (envelope as { error?: unknown }).error
      : undefined;
  if (error && typeof error === 'object') {
    const { code, message, details } = error as Record<string, unknown>;
    if (typeof code === 'string' && typeof message === 'string') {
      return new PushToApiError({
        status: response.status,
        code,
        message,
        details,
      });
    }
  }
  return new PushToApiError({
    status: response.status,
    code: 'http_error',
    message: `push-api answered HTTP ${response.status}`,
  });
}

/** Every call the SDK makes to push-api goes through {@link request}. */
export class ApiClient {
  /** Retries after the first attempt, on a network error or a `503` only. */
  public static maxRetries = 2;
  /** Doubles on each retry. */
  public static retryBaseDelayMs = 300;
  /**
   * Per attempt. A request that hangs would otherwise hold `event.waitUntil`
   * until Chrome kills the worker. A timeout counts as a network error.
   */
  public static timeoutMs = 10_000;

  constructor(
    private readonly apiKey: string,
    /** Ends in `/v1`; see {@link resolveApiBaseUrl}. */
    public readonly baseUrl: string,
  ) {}

  public async getVapidPublicKey(): Promise<string> {
    const body = await this.request<{ public_key?: unknown }>(
      'GET',
      '/vapid-key',
    );
    if (typeof body?.public_key !== 'string' || !body.public_key) {
      throw new PushToApiError({
        status: 200,
        code: 'invalid_response',
        message: 'GET /vapid-key answered without a public_key',
      });
    }
    return body.public_key;
  }

  /** Returns the push-api user id. */
  public async upsertUser(user: UpsertUserBody): Promise<number> {
    const body = await this.request<{ id?: unknown }>('POST', '/users', {
      body: user,
    });
    if (typeof body?.id !== 'number') {
      throw new PushToApiError({
        status: 200,
        code: 'invalid_response',
        message: 'POST /users answered without a numeric id',
      });
    }
    return body.id;
  }

  public async registerEndpoint(
    userId: number,
    endpoint: RegisterEndpointBody,
  ): Promise<void> {
    await this.request('POST', `/users/${userId}/endpoints`, {
      body: endpoint,
    });
  }

  /**
   * Sent with `keepalive`, which asks the browser to finish the request even
   * if its context goes away. Whether that holds for a terminated extension
   * service worker has not been verified; the push handler does not rely on
   * it (it awaits the post inside `waitUntil`).
   */
  public async sendFeedback(event: FeedbackEvent): Promise<void> {
    await this.request('POST', '/feedback', { body: event, keepalive: true });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; keepalive?: boolean } = {},
  ): Promise<T | undefined> {
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }
    if (options.keepalive) {
      init.keepalive = true;
    }

    let lastError: PushToApiError | undefined;
    for (let attempt = 0; attempt <= ApiClient.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(ApiClient.retryBaseDelayMs * 2 ** (attempt - 1));
      }

      let response: Response;
      try {
        response = await fetch(this.baseUrl + path, {
          ...init,
          signal: timeoutSignal(ApiClient.timeoutMs),
        });
      } catch (error) {
        lastError = new PushToApiError({
          status: 0,
          code: 'network_error',
          message: `${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch {
          return undefined;
        }
      }

      const error = await toApiError(response);
      if (response.status !== 503) {
        throw error;
      }
      lastError = error;
    }
    throw lastError;
  }
}
