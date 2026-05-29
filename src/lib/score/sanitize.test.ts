// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { sanitizeForDb, sanitizeJsonForDb, normalizeForAts } from "./sanitize";

describe("sanitizeForDb", () => {
  it("strips null bytes", () => {
    expect(sanitizeForDb("hello\x00world")).toBe("helloworld");
  });

  it("strips escaped null bytes", () => {
    expect(sanitizeForDb("hello\\u0000world")).toBe("helloworld");
  });

  it("strips lone surrogates", () => {
    expect(sanitizeForDb("hello\uD800world")).toBe("helloworld");
    expect(sanitizeForDb("hello\uDFFFworld")).toBe("helloworld");
  });

  it("strips replacement character", () => {
    expect(sanitizeForDb("hello\uFFFDworld")).toBe("helloworld");
  });

  it("preserves normal text", () => {
    expect(sanitizeForDb("Hello, World!")).toBe("Hello, World!");
  });

  it("handles empty string", () => {
    expect(sanitizeForDb("")).toBe("");
  });
});

describe("sanitizeJsonForDb", () => {
  it("sanitizes JSON strings the same way", () => {
    const json = '{"name": "hello\\u0000world"}';
    expect(sanitizeJsonForDb(json)).toBe('{"name": "helloworld"}');
  });
});

describe("normalizeForAts", () => {
  it("converts em-dash to hyphen", () => {
    expect(normalizeForAts("full\u2014stack")).toBe("full-stack");
  });

  it("converts en-dash to hyphen", () => {
    expect(normalizeForAts("2020\u20132024")).toBe("2020-2024");
  });

  it("converts smart double quotes to straight", () => {
    expect(normalizeForAts("\u201CHello\u201D")).toBe('"Hello"');
  });

  it("converts smart single quotes to straight", () => {
    expect(normalizeForAts("it\u2019s")).toBe("it's");
  });

  it("converts ellipsis to three dots", () => {
    expect(normalizeForAts("wait\u2026")).toBe("wait...");
  });

  it("removes zero-width characters", () => {
    expect(normalizeForAts("hello\u200Bworld")).toBe("helloworld");
    expect(normalizeForAts("hello\u200Cworld")).toBe("helloworld");
    expect(normalizeForAts("hello\uFEFFworld")).toBe("helloworld");
  });

  it("converts non-breaking space to regular space", () => {
    expect(normalizeForAts("hello\u00A0world")).toBe("hello world");
  });

  it("also applies sanitizeForDb (strips null bytes)", () => {
    expect(normalizeForAts("hello\x00\u2014world")).toBe("hello-world");
  });
});
