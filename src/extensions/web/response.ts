import { LIMITS } from "./constants.js";
import { abortReason, WebError } from "./errors.js";

export type BrowserResponse = {
  status: number;
  statusText: string;
  url: string;
  headers: Iterable<[string, string]>;
  body: ReadableStream<Uint8Array> | null;
};

const safeHeaders = new Set([
  "content-type",
  "content-language",
  "content-encoding",
  "content-length",
  "content-disposition",
  "last-modified",
  "etag",
  "location",
]);

export async function boundedResponse(
  source: BrowserResponse,
  signal: AbortSignal,
  finalUrl: string,
): Promise<Response> {
  const length = Number.parseInt(
    header(source.headers, "content-length") ?? "",
    10,
  );
  if (Number.isFinite(length) && length > LIMITS.responseBytes) {
    await source.body?.cancel().catch(() => {});
    throw new WebError(
      "oversize",
      "Web Fetch response exceeds its 5 MiB text limit.",
    );
  }
  const bytes = await readBody(source.body, signal);
  const headers = new Headers();
  for (const [name, value] of source.headers) {
    if (safeHeaders.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  }
  const emptyStatus =
    source.status === 204 || source.status === 205 || source.status === 304;
  const response = new Response(emptyStatus ? null : bytes, {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
  Object.defineProperty(response, "url", { value: finalUrl });
  if (signal.aborted) {
    throw abortReason(signal);
  }
  return response;
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
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
      if (bytes > LIMITS.responseBytes) {
        await reader.cancel();
        throw new WebError(
          "oversize",
          "Web Fetch response exceeds its 5 MiB text limit.",
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted) {
      throw abortReason(signal);
    }
    if (error instanceof WebError) {
      throw error;
    }
    throw new WebError("network", "Web Fetch response stream failed.");
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

export function header(
  headers: Iterable<[string, string]>,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  for (const [candidate, value] of headers) {
    if (candidate.toLowerCase() === expected) {
      return value;
    }
  }
  return undefined;
}
