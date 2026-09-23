import assert from "node:assert/strict";
import { test } from "node:test";

import { HpackDecoder, huffmanDecode } from "../../app/lib/http/hpack.js";
import { latin1 } from "../../app/lib/http/bytes.js";

const hex = (s) => Uint8Array.from(s.replace(/\s+/g, "").match(/../g).map((h) => parseInt(h, 16)));

test("RFC 7541 C.4: Huffman-coded requests with a dynamic table", () => {
  const d = new HpackDecoder();
  assert.deepEqual(d.decode(hex("8286 8441 8cf1 e3c2 e5f2 3a6b a0ab 90f4 ff")), [
    [":method", "GET"],
    [":scheme", "http"],
    [":path", "/"],
    [":authority", "www.example.com"],
  ]);
  assert.equal(d.size, 57);
  assert.deepEqual(d.decode(hex("8286 84be 5886 a8eb 1064 9cbf")), [
    [":method", "GET"],
    [":scheme", "http"],
    [":path", "/"],
    [":authority", "www.example.com"],
    ["cache-control", "no-cache"],
  ]);
  assert.deepEqual(d.decode(hex("8287 85bf 4088 25a8 49e9 5ba9 7d7f 8925 a849 e95b b8e8 b4bf")), [
    [":method", "GET"],
    [":scheme", "https"],
    [":path", "/index.html"],
    [":authority", "www.example.com"],
    ["custom-key", "custom-value"],
  ]);
  assert.equal(d.table.length, 3);
});

test("RFC 7541 C.3.1: literal strings without Huffman", () => {
  const d = new HpackDecoder();
  assert.deepEqual(d.decode(hex("8286 8441 0f77 7777 2e65 7861 6d70 6c65 2e63 6f6d")), [
    [":method", "GET"],
    [":scheme", "http"],
    [":path", "/"],
    [":authority", "www.example.com"],
  ]);
});

test("RFC 7541 C.6: responses with eviction at a 256-byte table", () => {
  const d = new HpackDecoder(256);
  const first = d.decode(hex("4882 6402 5885 aec3 771a 4b61 96d0 7abe 9410 54d4 44a8 2005 9504 0b81 66e0 82a6 2d1b ff6e 919d 29ad 1718 63c7 8f0b 97c8 e9ae 82ae 43d3"));
  assert.deepEqual(first, [
    [":status", "302"],
    ["cache-control", "private"],
    ["date", "Mon, 21 Oct 2013 20:13:21 GMT"],
    ["location", "https://www.example.com"],
  ]);
  assert.equal(d.size, 222);
  const second = d.decode(hex("4883 640e ffc1 c0bf"));
  assert.equal(second[0][1], "307");
  assert.equal(d.table.length, 4, "the 302 entry was evicted to make room");
});

test("huffman decoding rejects garbage and accepts EOS padding", () => {
  assert.equal(latin1(huffmanDecode(Uint8Array.from([0xf1, 0xe3, 0xc2, 0xe5, 0xf2, 0x3a, 0x6b, 0xa0, 0xab, 0x90, 0xf4, 0xff]))), "www.example.com");
  assert.throws(() => huffmanDecode(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff])));
});
