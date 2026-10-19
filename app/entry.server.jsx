/* global globalThis */
import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { startScheduler } from "./services/scheduler.server";

export const streamTimeout = 5000;

// Timed jobs (reminders, expiry, safety-net order sweep) start with the
// server process - there is no external cron to configure.
startScheduler();

// Once per server start: create any missing custom.* product metafield
// definitions (a fresh store has none). Skipped quietly when the app isn't
// installed on a store yet - afterAuth covers that case.
if (!globalThis.__rxMfDefsStarted) {
  globalThis.__rxMfDefsStarted = true;
  setTimeout(() => {
    import("./services/catalog.server.js")
      .then((m) => m.ensureProductMetafieldDefinitions())
      .then((r) => r.created.length && console.log("[rx] metafield definitions created:", r.created.join(", ")))
      .catch((err) => console.warn("[rx] metafield definitions not checked:", err.message || err));
  }, 5000);
}

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  remixContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
