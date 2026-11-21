/**
 * dsh-voice-widget client half.
 *
 * A draggable microphone button on the frame-wide overlay layer. It records one
 * dictation session through the host routes, then inserts the transcript into the
 * composer of the session the button belongs to. A null-rendering companion in
 * `conversation.input.dock` hands over that session's `inputActions`, because the
 * overlay layer is root-scoped and never receives session props.
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-widget',
  factory(require) {
    // Diagnostic: prove the bundle executed even if `apply` never runs.
    try {
      fetch('/dsh-voice-widget/ping?phase=factory', { cache: 'no-store' }).catch(() => {});
    } catch {
      // Ignore a blocked fetch: the diagnostic must not break module loading.
    }
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** Client locale namespace of this plugin. */
    const NS = 'voice-widget';
    /** Host route prefix; must match `ROUTE` in index.js. */
    const API = '/dsh-voice-widget';
    /** localStorage key holding the dragged button position. */
    const POS_KEY = 'dsh-voice-widget:position';
    /** Default anchor: right margin, above the composer, clear of the right rail. */
    const DEFAULT_POS = { right: 24, bottom: 132 };
    /** Polling cadence while a dictation session is running. */
    const POLL_MS = 220;

    const DICT = {
      zh: {
        'widget.label': '语音输入',
        'widget.start': '开始语音输入',
        'widget.stop': '结束并插入文字',
        'widget.starting': '正在打开麦克风…',
        'widget.listening': '正在听…（再点一下结束）',
        'widget.stopping': '正在收尾…',
        'widget.transcribing': '正在转写…',
        'widget.inserted': '已插入到输入框',
        'widget.copied': '已复制到剪贴板',
        'widget.empty': '没有听到内容',
        'widget.failed': '语音识别不可用',
        'widget.hint.insert': '点一下开始说话，再点一下插入当前输入框',
        'widget.hint.clipboard': '当前没有可插入的输入框，识别结果会复制到剪贴板',
        'widget.drag': '拖动可换位置',
      },
      en: {
        'widget.label': 'Voice input',
        'widget.start': 'Start dictation',
        'widget.stop': 'Stop and insert',
        'widget.starting': 'Opening the microphone…',
        'widget.listening': 'Listening… (click again to stop)',
        'widget.stopping': 'Finishing…',
        'widget.transcribing': 'Transcribing…',
        'widget.inserted': 'Inserted into the composer',
        'widget.copied': 'Copied to the clipboard',
        'widget.empty': 'Nothing was heard',
        'widget.failed': 'Speech recognition is unavailable',
        'widget.hint.insert': 'Click to dictate, click again to insert into the composer',
        'widget.hint.clipboard': 'No composer in reach, so the transcript goes to the clipboard',
        'widget.drag': 'Drag to move',
      },
    };

    // --- composer bridge ---------------------------------------------------

    /** Bridges registered by the per-session `conversation.input.dock` companion. */
    const bridges = new Set();
    let bridgeSeq = 0;
    const bridgeListeners = new Set();

    /** @returns the newest bridge whose element is actually laid out, if any. */
    function activeBridge() {
      const visible = [];
      for (const bridge of bridges) {
        const el = bridge.el;
        if (el && el.isConnected && el.offsetParent !== null) visible.push(bridge);
      }
      if (!visible.length) return undefined;
      return visible.sort((a, b) => b.seq - a.seq)[0];
    }

    /**
     * Insert transcript text at the current caret of the visible composer.
     * @param text - text to insert.
     * @returns whether the composer accepted it.
     */
    function insertTranscript(text) {
      const bridge = activeBridge();
      if (!bridge || typeof bridge.inputActions?.insertText !== 'function') return false;
      try {
        const span = bridge.inputActions.captureInsertion();
        return bridge.inputActions.insertText(text, span) === true;
      } catch {
        return false;
      }
    }

    /**
     * Hidden companion rendered inside a session composer.
     * @param props - session standard props, of which only `inputActions` is used.
     */
    function ComposerBridge(props) {
      const ref = useRef(null);
      const entry = useMemo(() => ({ seq: ++bridgeSeq, el: null }), []);
      entry.inputActions = props.inputActions;
      useEffect(() => {
        entry.el = ref.current;
        bridges.add(entry);
        bridgeListeners.forEach((listener) => listener());
        ping('bridge');
        return () => {
          bridges.delete(entry);
          bridgeListeners.forEach((listener) => listener());
        };
      }, [entry]);
      return h('span', {
        ref,
        'aria-hidden': true,
        style: { display: 'block', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' },
      });
    }

    /** @param phase - diagnostic label reported to the host. */
    function ping(phase) {
      fetch(`${API}/ping?phase=${encodeURIComponent(phase)}`, { cache: 'no-store' }).catch(() => {});
    }

    // --- transport ---------------------------------------------------------

    /** @param path - route-relative path with optional query. @returns decoded JSON or throws. */
    async function call(path) {
      const response = await fetch(API + path, { headers: { accept: 'application/json' }, cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      return payload;
    }

    /** @returns the persisted button anchor, falling back to the default. */
    function loadPosition() {
      try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (!raw) return DEFAULT_POS;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.right === 'number' && typeof parsed?.bottom === 'number') return parsed;
      } catch {
        // Corrupted entry: fall through to the default anchor.
      }
      return DEFAULT_POS;
    }

    /** @param pos - anchor to persist. */
    function savePosition(pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch {
        // Storage may be full or blocked; the position simply is not remembered.
      }
    }

    // --- widget ------------------------------------------------------------

    /** Lazily created portal host pinned above every frame layer. */
    let hostEl = null;

    /** @returns the body-level container the floating button is portalled into. */
    function widgetHost() {
      if (hostEl && hostEl.isConnected) return hostEl;
      hostEl = document.querySelector('[data-dsh-voice-widget]');
      if (!hostEl) {
        hostEl = document.createElement('div');
        hostEl.setAttribute('data-dsh-voice-widget', '');
        hostEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
        document.body.appendChild(hostEl);
      }
      return hostEl;
    }

    /** Removes the portal host; called when the plugin is disposed. */
    function dropWidgetHost() {
      if (hostEl && hostEl.isConnected) hostEl.remove();
      hostEl = null;
    }

    /** Overlay button: drag to move, click to dictate. */
    function VoiceWidget(props) {
      // The locale service may echo the key back on a miss, so only a different
      // string counts as a translation; otherwise the bundled dictionary wins.
      const t = useCallback((key) => {
        let value;
        try {
          value = props.t?.(key);
        } catch {
          value = undefined;
        }
        if (typeof value === 'string' && value && value !== key) return value;
        return DICT.zh[key] ?? key;
      }, [props.t]);
      const [pos, setPos] = useState(loadPosition);
      const [phase, setPhase] = useState('idle');
      const [partial, setPartial] = useState('');
      const [hostStatus, setHostStatus] = useState('');
      const [notice, setNotice] = useState('');
      const [canInsert, setCanInsert] = useState(() => Boolean(activeBridge()));
      const dragRef = useRef(null);
      const rootRef = useRef(null);
      const sessionRef = useRef({ since: 0, finals: [], reason: '' });
      const noticeTimer = useRef(0);

      useEffect(() => {
        ping('widget');
        const listener = () => setCanInsert(Boolean(activeBridge()));
        bridgeListeners.add(listener);
        return () => {
          bridgeListeners.delete(listener);
        };
      }, []);

      useEffect(() => () => {
        window.clearTimeout(noticeTimer.current);
        fetch(API + '/cancel', { cache: 'no-store' }).catch(() => {});
      }, []);

      /** @param text - short user-facing status shown above the button. */
      const flash = useCallback((text) => {
        setNotice(text);
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => setNotice(''), 2600);
      }, []);

      /** Deliver the collected transcript and reset the widget. */
      const finish = useCallback((text) => {
        const trimmed = text.trim();
        setPhase('idle');
        setPartial('');
        if (!trimmed) {
          flash(t('widget.empty'));
          return;
        }
        if (insertTranscript(trimmed)) {
          flash(t('widget.inserted'));
          return;
        }
        const clipboard = window.navigator?.clipboard;
        if (clipboard?.writeText) {
          clipboard.writeText(trimmed).then(
            () => flash(t('widget.copied')),
            () => flash(trimmed),
          );
          return;
        }
        flash(trimmed);
      }, [flash, t]);

      /** Start one dictation session. */
      const start = useCallback(async () => {
        sessionRef.current = { since: 0, finals: [], reason: '' };
        setPartial('');
        setPhase('starting');
        try {
          await call('/start');
          // The host answers once the capture is scheduled; the `ready` event
          // arrives when ffmpeg is really writing samples.
        } catch (error) {
          setPhase('idle');
          flash(`${t('widget.failed')}: ${error.message}`);
        }
      }, [flash, t]);

      /** Open the microphone early so the click itself costs no start-up delay. */
      const prime = useCallback(() => {
        fetch(API + '/warm', { cache: 'no-store' }).catch(() => {});
      }, []);

      /** Ask the host to finish the utterance. */
      const stop = useCallback(() => {
        setPhase('stopping');
        call('/stop').catch(() => {});
      }, []);

      /** Abort without inserting anything. */
      const cancel = useCallback(() => {
        setPhase('idle');
        setPartial('');
        fetch(API + '/cancel', { cache: 'no-store' }).catch(() => {});
      }, []);

      // Poll the host session while it is live.
      useEffect(() => {
        if (phase !== 'starting' && phase !== 'listening' && phase !== 'stopping') return undefined;
        let cancelled = false;
        const timer = window.setInterval(async () => {
          let payload;
          try {
            payload = await call(`/events?since=${sessionRef.current.since}`);
          } catch {
            return;
          }
          if (cancelled) return;
          setHostStatus(String(payload.status ?? ''));
          for (const event of payload.events ?? []) {
            sessionRef.current.since = Math.max(sessionRef.current.since, event.seq);
            if (event.type === 'partial') setPartial(event.text ?? '');
            if (event.type === 'ready') setPhase((current) => (current === 'starting' ? 'listening' : current));
            if (event.type === 'final') {
              const text = String(event.text ?? '').trim();
              if (text) sessionRef.current.finals.push(text);
              setPartial('');
            }
            if (event.type === 'error') {
              sessionRef.current.reason = event.message ?? 'error';
            }
          }
          if (payload.status === 'ended' || payload.status === 'error') {
            const text = sessionRef.current.finals.join('');
            if (text.trim()) finish(text);
            else if (sessionRef.current.reason || payload.error) {
              setPhase('idle');
              flash(`${t('widget.failed')}: ${sessionRef.current.reason || payload.error}`);
            } else finish('');
          }
        }, POLL_MS);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, [phase, finish, flash, t]);

      // Escape aborts a live session.
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && phase !== 'idle') cancel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [phase, cancel]);

      // --- dragging ---
      const onPointerEnter = useCallback(() => {
        if (phase === 'idle') prime();
      }, [phase, prime]);

      const onPointerDown = useCallback((event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = { x: event.clientX, y: event.clientY, start: pos, moved: false };
      }, [pos]);

      const onPointerMove = useCallback((event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        drag.moved = true;
        const next = {
          right: Math.min(Math.max(drag.start.right - dx, 0), Math.max(window.innerWidth - 64, 0)),
          bottom: Math.min(Math.max(drag.start.bottom - dy, 0), Math.max(window.innerHeight - 64, 0)),
        };
        setPos(next);
      }, []);

      const onPointerUp = useCallback((event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;
        if (drag.moved) {
          savePosition(pos);
          return;
        }
        event.preventDefault();
        if (phase === 'idle') start();
        else if (phase === 'listening') stop();
        else if (phase === 'starting' || phase === 'stopping') cancel();
      }, [pos, phase, start, stop, cancel]);

      const recording = phase === 'listening' || phase === 'stopping';
      const busy = phase === 'starting' || phase === 'stopping';
      const bubble = recording && partial ? partial : '';
      const status = phase === 'starting' ? t('widget.starting')
        : phase === 'listening' ? t('widget.listening')
          : phase === 'stopping' ? (hostStatus === 'transcribing' ? t('widget.transcribing') : t('widget.stopping'))
            : notice;

      const node = h('div', {
        ref: rootRef,
        style: {
          position: 'fixed',
          right: pos.right,
          bottom: pos.bottom,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 8,
          pointerEvents: 'none',
          zIndex: 2147483000,
          fontFamily: 'inherit',
        },
      },
      bubble || status
        ? h('div', {
          style: {
            pointerEvents: 'none',
            maxWidth: 340,
            padding: '7px 11px',
            borderRadius: 10,
            background: 'rgba(24, 26, 32, 0.92)',
            color: '#f2f4f8',
            fontSize: 12,
            lineHeight: 1.45,
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
        }, bubble || status)
        : null,
      h('button', {
        type: 'button',
        title: `${t('widget.label')} · ${t('widget.drag')}`,
        'aria-label': recording ? t('widget.stop') : t('widget.start'),
        onPointerDown,
        onPointerEnter,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        onContextMenu: (event) => event.preventDefault(),
        style: {
          pointerEvents: 'auto',
          width: 46,
          height: 46,
          padding: 0,
          borderRadius: 23,
          border: '1px solid rgba(255, 255, 255, 0.18)',
          background: recording ? '#e5484d' : phase === 'idle' ? '#2f6fed' : '#5b6270',
          color: '#ffffff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: recording
            ? '0 0 0 0 rgba(229, 72, 77, 0.6), 0 8px 22px rgba(0, 0, 0, 0.3)'
            : '0 8px 22px rgba(0, 0, 0, 0.26)',
          opacity: busy ? 0.85 : 1,
          transition: 'background 120ms ease, box-shadow 120ms ease, opacity 120ms ease',
          touchAction: 'none',
          WebkitAppRegion: 'no-drag',
        },
      }, h(MicIcon, { recording })));

      return createPortal(node, widgetHost());
    }

    /**
     * Microphone glyph; a filled square replaces it while recording.
     * @param props - `recording` selects the glyph.
     */
    function MicIcon(props) {
      if (props.recording) {
        return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true },
          h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 3, fill: 'currentColor' }));
      }
      return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 9, y: 3, width: 6, height: 10, rx: 3, fill: 'currentColor' }),
        h('path', {
          d: 'M5 11a7 7 0 0 0 14 0',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          fill: 'none',
        }),
        h('path', { d: 'M12 18v3', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ping('apply');
          ctx.effect(() => ctx.locale.register(NS, DICT));
          ctx.effect(() => dropWidgetHost);
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id: 'voice-widget', order: 1200, locale: NS,
          }, VoiceWidget));
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
            name: 'conversation.input.dock', id: 'voice-widget-bridge', order: 90,
          }, ComposerBridge));
        } catch (error) {
          ping(`apply-error:${(error && error.message) || error}`);
          throw error;
        }
      },
    };
  },
});
