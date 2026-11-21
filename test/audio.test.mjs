import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loudLevel } from '../lib/audio.js';

/**
 * Build a mono 16-bit WAV.
 * @param samples - Float samples in -1..1.
 * @param rate - sample rate.
 * @returns the file bytes.
 */
function wav(samples, rate = 16000) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('reports near-zero level for room noise', () => {
  const noise = Array.from({ length: 16000 }, (_, index) => Math.sin(index * 1.7) * 0.004);
  const level = loudLevel(wav(noise));
  assert.ok(level !== null && level < 0.01, `level was ${String(level)}`);
});

test('reports a high level once speech is present', () => {
  const sine = Array.from({ length: 16000 }, (_, index) => Math.sin((index / 16000) * 2 * Math.PI * 200) * 0.4);
  const level = loudLevel(wav(sine));
  assert.ok(level !== null && level > 0.2, `level was ${String(level)}`);
});

test('separates a quiet first half from a loud second half', () => {
  const quiet = new Array(8000).fill(0).map((_, index) => Math.sin(index * 1.7) * 0.004);
  const loud = new Array(8000).fill(0).map((_, index) => Math.sin((index / 8000) * 2 * Math.PI * 300) * 0.5);
  const level = loudLevel(wav([...quiet, ...loud]));
  assert.ok(level !== null && level > 0.3, `level was ${String(level)}`);
});

test('returns null for data that is not a WAV file', () => {
  assert.equal(loudLevel(Buffer.from('not a wav at all')), null);
});
