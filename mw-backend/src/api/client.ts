import { ApiError, NetworkError, TimeoutError, UnauthorizedError, NotFoundError, ValidationError } from "./errors.js";
import type { PaginatedResponse, SingleResponse, ApiErrorResponse } from "./types/figure.js";

export interface ClientOptions {
  baseUrl: string;
  timeout?: number;
  getToken?: () => string | null;
  onUnauthorized?: () => void;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
  signal?: AbortSignal;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter++;
  return `req-${requestCounter}-${Date.now().toString(36)}`;
}

export function createClient(options: ClientOptions) {
  const { baseUrl, timeout: defaultTimeout = 15000, getToken, onUnauthorized } = options;

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, params, timeout = defaultTimeout, signal: externalSignal } = opts;
    const requestId = nextRequestId();

    const url = new URL(`${baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      "Accept": "application/json",
    };

    const token = getToken?.();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const signal = externalSignal
      ? combineSignals(externalSignal, controller.signal)
      : controller.signal;

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });

      clearTimeout(timeoutId);

      const json: unknown = await response.json().catch(() => ({}));

      if (!response.ok || (typeof json === "object" && json !== null && "success" in json && (json as Record<string, unknown>).success === false)) {
        const errorBody = json as ApiErrorResponse;
        const apiCode = errorBody?.error?.code;
        const apiMessage = errorBody?.error?.message || response.statusText;

        switch (response.status) {
          case 401:
            onUnauthorized?.();
            throw new UnauthorizedError(requestId);
          case 404:
            throw new NotFoundError(path, requestId);
          case 422:
            throw new ValidationError(apiMessage || "Validation failed", requestId);
          default:
            throw new ApiError(apiMessage, response.status, apiCode, requestId);
        }
      }

      return (json as SingleResponse<T>).data ?? (json as T);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof ApiError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new TimeoutError(requestId);
      }
      throw new NetworkError(err instanceof Error ? err.message : "Unknown error", requestId);
    }
  }

  return {
    get<T>(path: string, opts?: RequestOptions): Promise<T> {
      return request<T>(path, { ...opts, method: "GET" });
    },
    post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
      return request<T>(path, { ...opts, method: "POST", body });
    },
    put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
      return request<T>(path, { ...opts, method: "PUT", body });
    },
    delete<T>(path: string, opts?: RequestOptions): Promise<T> {
      return request<T>(path, { ...opts, method: "DELETE" });
    },
  };
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export type ApiClient = ReturnType<typeof createClient>;
