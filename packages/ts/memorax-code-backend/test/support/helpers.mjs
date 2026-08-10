import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

export async function freePort() {
  const server = createServer((_, res) => res.end("ok"));
  const url = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return Number(new URL(url).port);
}

export async function readStreamUntil(response, pattern) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (pattern.test(text)) return text;
    }
    throw new Error(`stream did not match ${pattern}: ${text}`);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function fetchStreamUntil(url, pattern) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  try {
    assert.equal(response.status, 200);
    return await readStreamUntil(response, pattern);
  } finally {
    controller.abort();
  }
}
