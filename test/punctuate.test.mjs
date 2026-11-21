import assert from 'node:assert/strict';
import test from 'node:test';

import { punctuate, stripTimestamps } from '../lib/punctuate.js';

/** What whisper-server actually returned for a 29 s recording with timestamps on. */
const PUNCTUATED_CHINESE = ' 那你覺得現在的這個方案是要先去把具體的時間給要過來嗎?也就是每一個鑑定意見書的工作時間。'
  + '那這個時間具體是怎麼統計的呢?我覺得老師之前說的那個統計的方案還是有點不準確的,我想再細化一下。\n';

/** The same recording decoded with punctuation dropped altogether. */
const RUN_ON = [
  '那你觉得现在的这个方案是要先去把具体的时间给要过来吗',
  '也就是每一个鉴定意见书的工作时间',
  '那这个时间具体是怎么统计的呢',
  '我觉得老师之前说的那个统计的方案还是有点不准确的',
  '我想再细化一下',
].join('\n');

test('trims padding and widens ASCII marks next to Chinese characters', () => {
  assert.equal(
    punctuate(PUNCTUATED_CHINESE),
    '那你覺得現在的這個方案是要先去把具體的時間給要過來嗎？也就是每一個鑑定意見書的工作時間。'
      + '那這個時間具體是怎麼統計的呢？我覺得老師之前說的那個統計的方案還是有點不準確的，我想再細化一下。',
  );
});

test('rebuilds sentence marks at decoder pauses when whisper gave none', () => {
  assert.equal(
    punctuate(RUN_ON),
    '那你觉得现在的这个方案是要先去把具体的时间给要过来吗？'
      + '也就是每一个鉴定意见书的工作时间，'
      + '那这个时间具体是怎么统计的呢？'
      + '我觉得老师之前说的那个统计的方案还是有点不准确的。'
      + '我想再细化一下。',
  );
});

test('ends a single run-on segment with a full stop', () => {
  assert.equal(punctuate('我想把这段录音直接插入输入框'), '我想把这段录音直接插入输入框。');
});

test('keeps English segments apart and does not widen their marks', () => {
  assert.equal(punctuate('open the settings page\n然后点保存'), 'open the settings page.然后点保存。');
  assert.equal(punctuate('Open the settings page.\nThen save it.'), 'Open the settings page. Then save it.');
});

test('keeps empty input empty', () => {
  assert.equal(punctuate(''), '');
  assert.equal(punctuate('   \n  '), '');
});

test('strips whisper-cli timestamp prefixes', () => {
  const raw = '[00:00:00.000 --> 00:00:11.800]  第一句\n[00:00:11.800 --> 00:00:16.960]  第二句\n';
  assert.equal(stripTimestamps(raw), '第一句\n第二句');
});
