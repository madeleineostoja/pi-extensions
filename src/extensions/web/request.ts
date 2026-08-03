import { LIMITS } from "./constants.js";
import { abortReason, WebError } from "./errors.js";

export type ControlledRequest = {
  url: string;
  method: "GET" | "HEAD" | "POST";
  headers: Record<string, string>;
  body?: Uint8Array;
};

const forbiddenHeader =
  /^(?:authorization|cookie|host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|expect|content-length|accept-encoding|user-agent|referer|origin|priority|sec-.*)$/iu;

export async function normalizeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<ControlledRequest> {
  let request: Request;
  try {
    request = new Request(input, init);
  } catch {
    throw new WebError(
      "content",
      "Web Fetch received an invalid nested request.",
    );
  }
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    throw new WebError(
      "content",
      "Web Fetch permits only GET, HEAD, and POST requests.",
    );
  }
  if ((method === "GET" || method === "HEAD") && request.body) {
    throw new WebError(
      "content",
      "Web Fetch permits request bodies only for POST.",
    );
  }
  const body =
    method === "POST" ? await readBody(request.body, signal) : undefined;
  return {
    url: request.url,
    method,
    headers: Object.fromEntries(
      [...request.headers].filter(([name]) => !forbiddenHeader.test(name)),
    ),
    ...(body ? { body } : {}),
  };
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  if (!body) {
    return undefined;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const onAbort = () => void reader.cancel(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) {
        throw abortReason(signal);
      }
      const next = await reader.read();
      if (signal.aborted) {
        throw abortReason(signal);
      }
      if (next.done) {
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > LIMITS.requestBodyBytes) {
        await reader.cancel();
        throw new WebError(
          "oversize",
          "Web Fetch POST body exceeds its 1 MiB limit.",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted) {
      throw abortReason(signal);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
