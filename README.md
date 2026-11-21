# dsh-voice-widget

A free, fully offline dictation widget for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): a microphone button
floats over the DSH window, you speak, and the recognised text is inserted into the current session's composer.

It replaces the "dictate into WeChat's file-transfer chat → copy → paste into the coding tool" loop that costs two
window switches per sentence.

- **Engine:** local [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Default model `ggml-large-v3-q5_0` (1.0 GB).
  No account, no API key, no network at runtime.
- **Capture:** `ffmpeg -f dshow`, 16 kHz mono. Hovering the button pre-warms the microphone, so speech starts ~0.3 s after
  the click; stopping keeps recording 0.5 s more so the last syllable is not clipped.
- **Loudness:** no filter while recording — `highpass + dynaudnorm` is applied to the finished clip. A streaming filter
  ramps its gain from zero and swallows the first word, which was one of the original "it cuts my first word" causes.
- **Simplified Chinese:** whisper's Chinese output skews traditional; every transcript goes through **OpenCC**
  (`vendor/opencc-t2cn.js`, MIT AND Apache-2.0) before insertion.
- **Insertion:** the transcript is written at the caret of the active composer. With no composer available it falls back
  to the clipboard.
- **Cancel:** `Esc` while transcribing discards the take.

![status](https://img.shields.io/badge/platform-Windows-blue) ![status](https://img.shields.io/badge/license-MIT-green)

## Requirements

| | |
| --- | --- |
| OS | Windows 10/11 (DirectShow capture, whisper.cpp Windows builds) |
| DSH | desktop build with the web GUI; plugin slot API `conversation.input.dock` |
| ffmpeg | on `PATH`, or installed with `winget install Gyan.FFmpeg` |
| Disk | ~1.6 GB for the CUDA build + large-v3 model (or ~200 MB with `-CpuOnly -Model ggml-small-q5_1.bin`) |
| GPU | optional; an NVIDIA card makes large-v3 fast (RTX 4060 Laptop tested). Without CUDA it falls back to the CPU `whisper-cli`. |

## Install

1. **Get the binaries and a model.**

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1
   ```

   Downloads land in `%LOCALAPPDATA%\dsh-voice-widget\whisper\`. GitHub release assets are fetched through
   `gh-proxy.com`, models through `hf-mirror.com`, with the original URLs as fallback — both hosts are frequently
   unreachable from mainland China.

   Smaller/faster alternatives:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1 -CpuOnly -Model ggml-small-q5_1.bin
   powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1 -Model ggml-medium-q5_0.bin
   ```

2. **Install the bundle into DSH.** In the DSH plugin page, install/attach this directory as a local bundle, or from the
   CLI point the bundle installer at the repository root. The bundle id is `voice-widget`
   (`cordis.patch.yml` inserts `id: voice-widget, name: dsh-voice-widget`).

3. **Reload.** Toggle the plugin off and on (or restart DSH). About 1.5 s later the host side boots `whisper-server.exe`
   and keeps the model resident in VRAM.

## Use

1. A blue microphone button appears at the bottom-right of the window (drag to move; the position is kept in
   `localStorage`).
2. Hover it (pre-warm) → click. The button turns **red** only once the microphone is genuinely capturing
   (grey means the device is still opening).
3. Speak at normal volume and pace; click again when you are done.
4. A bubble shows the state; roughly 0.5–1.5 s later the text lands in the composer.

## Performance (measured on i9-14900HX / RTX 4060 Laptop 8 GB)

| Configuration | One 2–7 s sentence | Notes |
| --- | --- | --- |
| CPU + `ggml-small-q5_1` | ≈ 5.8 s | no CUDA, least VRAM |
| CPU + turbo | ≈ 9.4 s | model reloaded on every call |
| **CUDA + large-v3 warm server (default)** | **≈ 0.3–1.6 s** | model stays in VRAM, only inference is paid |

Click-to-text end to end is ≈ 1.5–2 s including the capture tail and the request round trip.

## Configuration

- **Model:** drop any `ggml-*.bin` into `%LOCALAPPDATA%\dsh-voice-widget\whisper\models\`. The plugin picks the first hit
  from `large-v3` → `large-v3-turbo` → `medium` → `small`; unquantised (fp16) wins over `q5_0` at the same tier.
- **Audio device:** by default the first DirectShow capture device ffmpeg enumerates. Set `audioDevice` in the bundle
  config to force another one —
  `ffmpeg -hide_banner -list_devices true -f dshow -i dummy` prints the exact names.
- **Last take:** the normalised clip is kept as `%LOCALAPPDATA%\dsh-voice-widget\last.wav` for offline reproduction.

## How it works

```
client.js  (browser, shell.overlay → portal)
   │  click / hover
   ▼
POST /dsh-voice-widget/start ──► ffmpeg -f dshow ──► rec-*.wav (16 kHz mono)
   │                                  │ -progress pipe:1 tells us real samples exist
   │                                  ▼
POST /dsh-voice-widget/stop  ──► normalise (highpass + dynaudnorm)
                                      ▼
                         whisper-server /inference (CUDA, warm) ──► CLI fallback
                                      ▼
                          OpenCC t→cn ──► punctuation ──► insert at caret
```

The overlay button cannot live in DSH's `shell.overlay` stacking context — the slot wraps occupants in a 0×0 box and the
conversation panel paints above the layer. The widget therefore portals into `document.body` with its own fixed layer.
Transcript insertion uses a hidden `conversation.input.dock` companion that publishes the session's `inputActions`.

**Punctuation.** Greedy whisper decoding puts at most one mark at the very end of a Chinese utterance — `…换更好的模型。`
— because it never samples the comma tokens. Two things fix that:

1. `/inference` is called with `no_timestamps=false` (`-nt` is dropped from the CLI fallback too). Without it whisper
   strips every mark, not just the commas.
2. When a transcript has no inner punctuation and is longer than eight characters, a **second decode at
   temperature 0.8** runs and recovers the commas: `还有一种方案，就是可以选择用户自己接入API Key，换更好的模型。或者…`.
   Sampled decoding can hallucinate a whole sentence out of silence (2 s of silence produced *请不吝点赞 订阅 转发 打赏*),
   so the sampled text is only kept when `sameText` finds it identical to the greedy text apart from punctuation and
   whitespace (≤ 2 % Levenshtein). Otherwise the greedy text wins.

`lib/punctuate.js` then trims the text, joins decoder segments, widens ASCII `,?!;:` to `，？！；：` where they sit next
to Chinese (leaving `1,000` alone), and — if a decode still returned one run-on line — rebuilds sentence ends from the
pauses whisper reported: a pause after 吗/呢/吧 becomes `？`, a pause before 那/然后/所以 stays `，`.

**Silence.** whisper decodes room noise into stray characters (three seconds of nothing came back as `颊。`), so the
recording is measured before it is decoded: `lib/audio.js` computes the per-frame RMS, and a clip whose loud frames stay
below 0.015 (≈ −36 dBFS — room noise measures ≈ 0.007, quiet speech starts near 0.02) is dropped without a decode. The
widget then reports *没听到内容* instead of inserting garbage.

## Known limitations

- One utterance at a time, 300 s cap; no continuous dictation, no wake word.
- Long utterances pay for the punctuation pass twice: a 28 s clip takes ≈ 1.9 s end to end, a 5 s one ≈ 0.6 s. When the
  sampled decode disagrees with the greedy one, the transcript keeps the model's single end mark.
- Chinese accuracy still trails cloud transcription (WeChat): the laptop array microphone is quiet (≈ −32 dBFS
  raw speech), and there is no server-side AGC. The capture chain compensates, but very quiet or very fast speech still
  produces errors.
- Opening the microphone costs ≈ 1.2 s of DirectShow start-up; hovering hides it, clicking cold does not.
- Windows only.

## Layout

| File | Role |
| --- | --- |
| `index.js` | Host side: capture (pre-warm + tail), silence gate, two-pass transcription, OpenCC, `/dsh-voice-widget/*` routes |
| `lib/punctuate.js` | Sentence marks at decoder pauses, ASCII→full-width widening, CLI timestamp stripping |
| `lib/audio.js` | Loud-frame level of a WAV clip, used to drop room noise before decoding |
| `test/*.test.mjs` | `node --test test/` covers the punctuation and level rules |
| `client.js` | Browser side: floating button, pre-warm on hover, session polling, insertion |
| `scripts/setup-whisper.ps1` | Downloads whisper.cpp builds and models |
| `vendor/opencc-t2cn.js` | OpenCC traditional→simplified dictionary, vendored so no install step is needed |
| `locale/*.json` | Title and description shown in the DSH plugin page |

## License

MIT (see `LICENSE`). Bundled OpenCC data is MIT AND Apache-2.0; whisper.cpp and the ggml models are downloaded at setup
time under their own MIT licenses.
