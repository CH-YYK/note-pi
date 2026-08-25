/**
 * Mobile-safe provider transport.
 *
 * Obsidian's `requestUrl` is the only network path that works identically on
 * desktop and the iOS WebView (it bypasses WebView CORS restrictions). This
 * adapts it to the fetch-shaped interface Pi's providers expect.
 *
 * Caveat: `requestUrl` buffers the whole response, so provider output is not
 * token-streamed over the wire; the ReadableStream wrapper delivers the
 * completed body to Pi's SSE parser in one chunk. Cancellation stops the
 * local agent loop but cannot abort the in-flight HTTP request, because
 * `requestUrl` does not accept an AbortSignal.
 */
export function obsidianRequestUrlFetch(requestUrl) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const response = await requestUrl({
      url,
      method: init.method ?? "POST",
      headers: init.headers ?? {},
      body: init.body,
      throw: false
    });
    const bytes = new Uint8Array(response.arrayBuffer);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: "",
      url,
      headers: new Headers(response.headers),
      body,
      text: async () => response.text,
      json: async () => response.json,
      arrayBuffer: async () => response.arrayBuffer
    };
  };
}
