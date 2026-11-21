import assert from 'node:assert/strict';
import test from 'node:test';

import { needsPunctuation, punctuate, sameText, stripTimestamps } from '../lib/punctuate.js';

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

test('widens an ASCII mark that sits right before a Chinese character', () => {
  assert.equal(punctuate('换成用户自己接入API Key,换更好的模型。'), '换成用户自己接入API Key，换更好的模型。');
  assert.equal(punctuate('1,000 次调用'), '1,000 次调用');
});

test('strips whisper-cli timestamp prefixes', () => {
  const raw = '[00:00:00.000 --> 00:00:11.800]  第一句\n[00:00:11.800 --> 00:00:16.960]  第二句\n';
  assert.equal(stripTimestamps(raw), '第一句\n第二句');
});

test('asks for a second pass only when a transcript has no inner punctuation', () => {
  assert.equal(needsPunctuation('还有一种方案就是可以选择用户自己接入API Key换更好的模型或者保持默认的情况就是用免费的模型。'), true);
  assert.equal(needsPunctuation('第一，把按钮改成圆角。第二，在右下角加一个图标。'), false);
  assert.equal(needsPunctuation('帮我看一下这个函数，是不是参数传错了？'), false);
  assert.equal(needsPunctuation('好的。'), false);
  assert.equal(needsPunctuation(''), false);
});

test('accepts a sampled decode only when it says the same thing', () => {
  const greedy = '还有一种方案就是可以选择用户自己接入API Key换更好的模型或者保持默认的情况就是用免费的模型。';
  const sampled = '还有一种方案，就是可以选择用户自己接入API Key，换更好的模型。或者保持默认的情况，就是用免费的模型。';
  assert.equal(sameText(greedy, sampled), true);
  assert.equal(sameText(greedy, '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目'), false);
  assert.equal(sameText(greedy, ''), false);
});
