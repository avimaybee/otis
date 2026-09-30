import type { HttpErrorResponse } from '@otis/contracts';

export function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryable = false,
  details?: unknown,
): Response {
  const body: HttpErrorResponse = {
    error: {
      code,
      message,
      retryable,
      request_id: requestId,
      ...(details !== undefined ? { details } : {}),
    },
  };

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'x-request-id': requestId,
    },
  });
}

export function jsonSuccess<T>(data: T, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has('Content-Type')) {
    responseHeaders.set('Content-Type', 'application/json');
  }
  if (!responseHeaders.has('Cache-Control')) {
    responseHeaders.set('Cache-Control', 'no-store');
  }

  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}
