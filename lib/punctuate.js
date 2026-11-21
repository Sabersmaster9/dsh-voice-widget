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

/**
 * @param text - mixed text.
 * @returns it with ASCII marks widened where they sit inside Chinese: after a
 * Chinese character (`吗?`) or right before one (`API Key,换`). Marks between
 * digits (`1,000`) are left alone.
 */
function widen(text) {
  return text
    .replace(/([\u4e00-\u9fff])([,?!;:])/g, (match, han, mark) => han + WIDE[mark])
    .replace(/([,?!;:])(?=[\u4e00-\u9fff])/g, (mark) => WIDE[mark]);
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

/** Marks that only ever sit inside a sentence, never at its end. */
const INNER_MARKS = /[，,、；;：]/;

/**
 * Greedy decoding tends to place at most one mark at the very end, which is
 * exactly the signal that a second, temperature-sampled decode might recover
 * the commas. Short clips are not worth that second pass.
 * @param text - transcript from the greedy pass.
 * @returns true when another pass could add inner punctuation.
 */
export function needsPunctuation(text) {
  if (typeof text !== 'string') return false;
  const body = text.trim().replace(/[。．.？?！!]+$/, '');
  if (body.length < 8) return false;
  return !INNER_MARKS.test(body);
}

/** @param text - any transcript. @returns it without whitespace or punctuation. */
function bare(text) {
  return text.replace(/[\s，。！？；：、,.?!;:'"“”‘’()（）[\]{}<>-]/g, '');
}

/**
 * Whether two decodes say the same thing. A temperature-sampled pass may pick
 * up commas but must never be allowed to invent words, so its text is only
 * trusted when it matches the greedy text this closely.
 * @param left - reference transcript. @param right - candidate transcript.
 * @returns true when the two differ by at most 2% of their characters.
 */
export function sameText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = bare(left);
  const b = bare(right);
  if (a === b) return true;
  if (a === '' || b === '') return false;
  const allowed = Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.02));
  if (Math.abs(a.length - b.length) > allowed) return false;
  // Levenshtein distance, two rolling rows, early exit past the budget.
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (current[j] < best) best = current[j];
    }
    if (best > allowed) return false;
    previous = current;
  }
  return previous[b.length] <= allowed;
}
