/**
 * Tiny WAV level helpers. whisper happily decodes room noise into stray
 * characters ("颊。"), so the host measures the clip before spending a decode
 * on it.
 */

/** Length of one analysis frame, in seconds. */
const FRAME_SECONDS = 0.03;

/** @param buffer - whole WAV file. @returns { rate, dataStart, dataSize } or null. */
function locateData(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  const rate = buffer.readUInt32LE(24);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      const dataStart = offset + 8;
      return { rate, dataStart, dataSize: Math.min(size, buffer.length - dataStart) };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Per-frame RMS levels of a 16-bit PCM WAV.
 * @param buffer - whole WAV file.
 * @returns quantile accessor over frame levels, or null when unparseable.
 */
function levelsOf(buffer) {
  const data = locateData(buffer);
  if (!data || data.rate <= 0) return null;
  const frame = Math.max(1, Math.round(data.rate * FRAME_SECONDS));
  const levels = [];
  const end = data.dataStart + data.dataSize;
  for (let start = data.dataStart; start + frame * 2 <= end; start += frame * 2) {
    let sum = 0;
    for (let i = 0; i < frame; i += 1) {
      const sample = buffer.readInt16LE(start + i * 2) / 32768;
      sum += sample * sample;
    }
    levels.push(Math.sqrt(sum / frame));
  }
  if (levels.length === 0) return null;
  levels.sort((a, b) => a - b);
  return (quantile) => levels[Math.min(levels.length - 1, Math.floor(levels.length * quantile))] ?? 0;
}

/**
 * Loud-frame level of a clip: the level 90 % of frames stay below. Room noise
 * sits around 0.007 while quiet speech starts near 0.02, so the caller can cut
 * silence without a fixed absolute threshold on the peak.
 * @param buffer - whole WAV file.
 * @returns the level, or null when the file cannot be parsed.
 */
export function loudLevel(buffer) {
  const quantile = levelsOf(buffer);
  return quantile ? quantile(0.9) : null;
}

export { FRAME_SECONDS };
