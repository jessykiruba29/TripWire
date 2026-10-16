/**
 * Transport layer.
 *
 * Two interchangeable transports behind one interface:
 *   - `live`  — HTTP against the real Tripwire backend (`VITE_API_BASE_URL`).
 *   - `mock`  — the deterministic reference engine, executed in the browser.
 *
 * Both go through the SAME router implementation (`mock-backend/engine`), so the
 * mock adapter cannot drift into a parallel universe of made-up payloads. The
 * active transport is always surfaced in the UI (`health.mode` + a banner).
 */

import { createRouter, TripwireStore } from '@engine/router.js';
import type { ApiErrorBody } from './types';

export type HttpMethod = 'GET' | 'POST';
export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  signal?: AbortSignal;
}

export interface Transport {
  readonly kind: 'live' | 'mock';
  readonly label: string;
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
}

export class TripwireApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TripwireApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isValidation(): boolean {
    return this.status === 422 || this.status === 400;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  /** Network/DNS/refused — no HTTP response at all. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

/**
 * The single place a URL is assembled. No component builds a URL by hand.
 */
export function buildUrl(baseUrl: string, path: string, query?: QueryParams): string {
  const base = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Two error envelopes exist in this project and both must be understood:
 *
 *   reference engine : { "error": { "code": "...", "message": "...", "details": {} } }   (nested)
 *   real FastAPI     : { "error": "not_found", "message": "...", "details": {} }          (flat)
 *
 * Verified live: the real backend returns HTTP 404 with
 * `{"error":"not_found","message":"decision '…' does not exist","details":{…}}`.
 * Without the flat branch every real-backend error would surface as
 * "internal_error" with no code, hiding the actual cause from the user.
 */
function toApiError(status: number, payload: unknown, fallback: string): TripwireApiError {
  const body = payload as (ApiErrorBody & { error?: unknown; message?: unknown; details?: unknown }) | undefined;

  if (body && typeof body === 'object' && 'error' in body) {
    const { error } = body;

    // nested envelope
    if (error && typeof error === 'object') {
      const nested = error as { code?: string; message?: string; details?: Record<string, unknown> };
      return new TripwireApiError(status, nested.code ?? 'internal_error', nested.message ?? fallback, nested.details ?? {});
    }

    // flat envelope
    if (typeof error === 'string') {
      return new TripwireApiError(
        status,
        error,
        typeof body.message === 'string' ? body.message : fallback,
        (body.details as Record<string, unknown>) ?? {},
      );
    }
  }

  return new TripwireApiError(status, 'internal_error', fallback, {});
}

export interface HttpTransportOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createHttpTransport({ baseUrl, fetchImpl, timeoutMs = 15000 }: HttpTransportOptions): Transport {
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);

  return {
    kind: 'live',
    label: baseUrl,
    async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
      if (!doFetch) {
        throw new TripwireApiError(0, 'unavailable', 'No fetch implementation is available in this environment.');
      }

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort);
      const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

      try {
        const response = await doFetch(buildUrl(baseUrl, path, options.query), {
          method,
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });

        const text = await response.text();
        let payload: unknown = undefined;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            throw new TripwireApiError(
              response.status,
              'internal_error',
              `Backend returned a non-JSON response for ${method} ${path}.`,
            );
          }
        }

        if (!response.ok) throw toApiError(response.status, payload, `Request failed with status ${response.status}.`);
        return payload as T;
      } catch (error) {
        if (error instanceof TripwireApiError) throw error;
        const aborted = (error as { name?: string })?.name === 'AbortError';
        throw new TripwireApiError(
          0,
          aborted ? 'timeout' : 'unavailable',
          aborted
            ? `No response from the Tripwire backend within ${Math.round(timeoutMs / 1000)}s.`
            : `Cannot reach the Tripwire backend at ${baseUrl}.`,
          { cause: String((error as Error)?.message ?? error) },
        );
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

export interface EngineTransportOptions {
  /** Simulated round-trip delay, lets loading states be seen and tested. */
  latencyMs?: number;
}

/**
 * In-browser transport. Executes the deterministic reference engine directly, so
 * mock mode returns exactly what the reference backend returns — including its
 * error envelopes and 4xx codes.
 */
export function createEngineTransport({ latencyMs = 0 }: EngineTransportOptions = {}): Transport {
  const router = createRouter(new TripwireStore());

  return {
    kind: 'mock',
    label: 'in-browser reference engine',
    async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value === undefined || value === null || value === '') continue;
        query[key] = String(value);
      }

      const { status, body } = router.handle(method, path, query, (options.body ?? {}) as object);

      if (status >= 400) throw toApiError(status, body, `Mock engine returned status ${status}.`);
      return body as T;
    },
  };
}
