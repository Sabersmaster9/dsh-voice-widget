/**
 * Sentence punctuation cleanup for whisper.cpp transcripts.
 *
 * Two things go wrong with Chinese dictation. First, whisper mixes ASCII
 * punctuation into Chinese text (`你好吗?`), which reads badly next to full
 * width characters. Second, when the decoder runs with timestamps suppressed
 * it can drop every comma and full stop and return one long run-on line.
 *
 * The second case is recoverable because the decoder still breaks its output
 * wherever the speaker paused: a pause after 吗/呢/吧 is a question, a pause
 * right before 那/然后/所以 continues the same sentence, and any other pause
 * ends one.
 */

/** Any of these means whisper punctuated on its own, so the heuristics stay out. */
const PUNCTUATED = /[，。！？；：,.?!;:、]/;
/** Particles that turn a spoken pause into a question. */
const QUESTION_TAIL = /[吗呢吧嘛么哦啦呀]$/;
/** Openers that usually continue the clause before them. */
const CONTINUATION_HEAD = /^(那|那么|然后|也就是|就是|所以|但是|但|而且|另外|还有|不过|因为|其实|如果|虽然|以及|并且|或者|而是)/;
/** Enough of the CJK Unified Ideographs block to tell Chinese from English. */
const CJK = /[\u4e00-\u9fff]/;
/** ASCII marks that should be full width when they follow a Chinese character. */
const WIDE = { ',': '，', '?': '？', '!': '！', ';': '；', ':': '：' };

/** @param line - one decoder segment. @returns it without stray separators. */
function cleanSegment(line) {
  return line.trim().replace(/[，,、\s]+$/, '');
}

/** @param text - mixed text. @returns it with Chinese-adjacent ASCII marks widened. */
function widen(text) {
  return text.replace(/([\u4e00-\u9fff])([,?!;:])/g, (match, han, mark) => han + WIDE[mark]);
}

/**
 * Normalise a transcript: trim it, drop stray line breaks, widen ASCII
 * punctuation, and rebuild sentence marks at the pauses when whisper gave none.
 * @param text - raw transcript, one decoder segment per line.
 * @returns the transcript ready to be inserted into the page.
 */
export function punctuate(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (PUNCTUATED.test(trimmed)) {
    // Whisper punctuated already; only the line breaks need deciding.
    return widen(lines.join(CJK.test(trimmed) ? '' : ' '));
  }
  const parts = lines.map(cleanSegment).filter((part) => part !== '');
  if (parts.length === 0) return '';
  let out = '';
  parts.forEach((part, index) => {
    const next = parts[index + 1];
    if (!CJK.test(part)) {
      out += `${part}.`;
      return;
    }
    let mark = '。';
    if (QUESTION_TAIL.test(part)) mark = '？';
    else if (next !== undefined && CONTINUATION_HEAD.test(next)) mark = '，';
    out += part + mark;
  });
  return widen(out);
}

/**
 * Drop the `[00:00:00.000 --> 00:00:11.800]` prefixes whisper-cli prints when
 * it runs with segment timestamps, keeping the bare segment lines.
 * @param raw - whisper-cli stdout.
 * @returns one segment per line.
 */
export function stripTimestamps(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]*-->\s*[^\]]*\]\s*/, '').trim())
    .filter((line) => line !== '')
    .join('\n');
}
