import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MEMORAX_ACCOUNT_URL,
  MEMORAX_DEFAULT_BASE_URL,
  normalizeMemoraxBaseUrl,
} from "../src/memorax-defaults.mjs";

test("MemoraX defaults use the current platform domain", () => {
  assert.equal(MEMORAX_DEFAULT_BASE_URL, "https://platform.memoraxai.com");
  assert.equal(MEMORAX_ACCOUNT_URL, "https://platform.memoraxai.com/");
});

test("legacy official endpoints resolve directly to the current platform", () => {
  for (const endpoint of [
    "https://platform.memorax.net",
    " https://platform.memorax.net/// ",
    "HTTPS://PLATFORM.MEMORAX.NET:443/",
  ]) {
    const normalized = normalizeMemoraxBaseUrl(endpoint);
    assert.equal(normalized, "https://platform.memoraxai.com", endpoint);
    assert.equal(normalizeMemoraxBaseUrl(normalized), normalized);
  }
});

test("endpoint migration preserves custom addresses and only trims their existing syntax", () => {
  for (const endpoint of [
    "https://custom.example/api",
    "http://platform.memorax.net",
    "https://platform.memorax.net:8443",
    "https://platform.memorax.net/api",
    "https://platform.memorax.net/path/..",
    "https://platform.memorax.net?project=custom",
    "https://platform.memorax.net#custom",
    "https://fixture:secret@platform.memorax.net",
    "https://platform.memorax.net.example",
    "https://platform.memorax.net@custom.example",
    "not-a-url",
  ]) {
    assert.equal(normalizeMemoraxBaseUrl(endpoint), endpoint);
  }
  assert.equal(normalizeMemoraxBaseUrl(" https://custom.example/api/// "), "https://custom.example/api");
  assert.equal(normalizeMemoraxBaseUrl(undefined), "");
});
