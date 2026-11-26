// Content script: recognizes the captcha shown on the login page and fills it in.
// It never reads, stores, or submits your account or password.
(function () {
  function $(s) { return document.querySelector(s); }

  // ---- Hiding the captcha -------------------------------------------------
  // Injected as early as possible (document_start) so the captcha never flashes.
  const EARLY_STYLE_ID = 'ntut-ext-early-hide';
  const HIDDEN_CLASS = 'ntut-ext-hidden';
  function addStyle(id, css) {
    if (document.getElementById(id)) return;
    const st = document.createElement('style');
    st.id = id; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  function earlyHide() {
    addStyle(EARLY_STYLE_ID, '#authImage,#authcode{visibility:hidden!important}');
  }

  // The captcha's own controls: the image, the input, and the「更新驗證碼」link.
  // If the image and input share a container (e.g. a table row) that holds no
  // other login field, hide that whole container so its label goes too.
  let hiddenEls = [];
  function captchaParts(img, code) {
    let box = img.parentElement;
    while (box && !box.contains(code)) box = box.parentElement;
    const others = '#muid,#mpassword,input[type=password],input[type=submit],button';
    if (box && box !== document.body && box.tagName !== 'FORM' && !box.querySelector(others)) {
      return [box];
    }
    const parts = [img, code];
    for (const el of document.querySelectorAll('a,span,input[type=button],img')) {
      const hint = (el.getAttribute('onclick') || '') + (el.getAttribute('href') || '') + el.textContent;
      if (el !== img && /refreshAuthImage|更新驗證碼/.test(hint) && !el.querySelector(others)) parts.push(el);
    }
    return parts;
  }
  // ---- Status UI -----------------------------------------------------------
  // One visual language for both places a status can appear:
  //  - inline chip that takes the hidden captcha's place (sized like its input)
  //  - floating toast at the bottom-right when the captcha is visible
  // Both live in a shadow root so the portal's CSS can't restyle them.
  const ICONS = {
    busy: '<svg viewBox="0 0 24 24" class="spin"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="42 100" stroke-linecap="round"/></svg>',
    ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="currentColor"/><path class="tick" d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M12 7v6M12 16.5v.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
    error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
  };
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

  const BASE_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui { --fg:#334155; --muted:#94a3b8; --bg:#f8fafc; --line:#e2e8f0; --accent:#64748b;
      font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif;
      color: var(--fg); letter-spacing: .02em;
      transition: background-color .35s ease, border-color .35s ease, color .35s ease; }
    .ui[data-state=ok]    { --fg:#065f46; --muted:#10b981; --bg:#ecfdf5; --line:#a7f3d0; --accent:#10b981; }
    .ui[data-state=warn]  { --fg:#92400e; --muted:#d97706; --bg:#fffbeb; --line:#fde68a; --accent:#f59e0b; }
    .ui[data-state=error] { --fg:#991b1b; --muted:#ef4444; --bg:#fef2f2; --line:#fecaca; --accent:#ef4444; }
    .icon { flex: none; width: 16px; height: 16px; color: var(--accent); display: grid; }
    .icon svg { width: 100%; height: 100%; }
    .spin { animation: spin .8s linear infinite; }
    .tick { stroke-dasharray: 16; stroke-dashoffset: 16; animation: draw .45s .1s cubic-bezier(.65,0,.35,1) forwards; }
    .icon.pop { animation: pop .35s cubic-bezier(.34,1.56,.64,1); }
    .dots::after { content: ''; animation: dots 1.2s steps(4) infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    @keyframes pop { from { transform: scale(.4); opacity: 0; } }
    @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
    @media (prefers-reduced-motion: reduce) { * { animation-duration: 0s !important; animation-iteration-count: 1 !important; } }
  `;

  function render(root, state, title, sub) {
    const ui = root.querySelector('.ui');
    const iconEl = root.querySelector('.icon');
    if (ui.dataset.state !== state) {
      ui.dataset.state = state;
      iconEl.innerHTML = ICONS[state];
      iconEl.classList.remove('pop'); void iconEl.offsetWidth; // restart animation
      if (state !== 'busy') iconEl.classList.add('pop');
    }
    const t = root.querySelector('.title');
    t.textContent = title;
    t.classList.toggle('dots', state === 'busy');
    const s = root.querySelector('.sub');
    if (s) { s.textContent = sub || ''; s.hidden = !sub; }
  }

  // Inline chip shown in place of the hidden captcha.
  let statusBox = null;
  function makeStatusBox(anchor, code) {
    const r = code.getBoundingClientRect();
    const host = document.createElement('span');
    host.id = 'ntut-ext-status';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${BASE_CSS}
      .ui { display: inline-flex; align-items: center; gap: 8px; vertical-align: middle;
        height: ${Math.max(32, Math.round(r.height) || 0)}px; min-width: ${Math.max(168, Math.round(r.width) || 0)}px;
        padding: 0 4px 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg);
        position: relative; overflow: hidden; }
      .ui[data-state=busy]::after { content: ''; position: absolute; inset: 0;
        background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.75) 50%, transparent 70%);
        transform: translateX(-100%); animation: sweep 1.3s ease-in-out infinite; }
      @keyframes sweep { to { transform: translateX(100%); } }
      .text { display: flex; align-items: baseline; gap: 6px; flex: 1; white-space: nowrap; }
      .sub { font-size: 11px; font-weight: 400; color: var(--muted); }
      button { all: unset; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px;
        color: var(--muted); cursor: pointer; transition: background-color .2s, color .2s; }
      button:hover { background: rgba(0,0,0,.05); color: var(--fg); }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      button svg { width: 16px; height: 16px; }
    </style>
    <span class="ui" role="status" aria-live="polite">
      <span class="icon"></span>
      <span class="text"><span class="title"></span><span class="sub" hidden></span></span>
      <button type="button" title="顯示驗證碼" aria-label="顯示驗證碼">${EYE}</button>
    </span>`;
    root.querySelector('button').addEventListener('click', (e) => { e.preventDefault(); showCaptcha(); });
    // A hidden table row can't be replaced by a bare <span>: give it a row of its own.
    let holder = host;
    if (anchor.tagName === 'TR') {
      holder = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = Math.max(1, anchor.cells.length);
      td.appendChild(host); holder.appendChild(td);
    }
    anchor.parentNode.insertBefore(holder, anchor);
    return { holder, host, root };
  }

  function hideCaptcha(img, code) {
    addStyle('ntut-ext-hide', `.${HIDDEN_CLASS}{display:none!important}`);
    hiddenEls = captchaParts(img, code);
    // Measure the input while it still occupies layout (early style uses visibility).
    statusBox = makeStatusBox(hiddenEls.length === 1 ? hiddenEls[0] : code, code);
    hiddenEls.forEach((el) => el.classList.add(HIDDEN_CLASS));
    document.getElementById(EARLY_STYLE_ID)?.remove();
  }
  function showCaptcha() {
    hiddenEls.forEach((el) => el.classList.remove(HIDDEN_CLASS));
    hiddenEls = [];
    if (statusBox) { statusBox.holder.remove(); statusBox = null; }
    document.getElementById(EARLY_STYLE_ID)?.remove();
  }

  // Floating toast, used when the captcha is visible.
  let toast = null, toastTimer = 0;
  function getToast() {
    if (toast && toast.host.isConnected) return toast;
    const host = document.createElement('div');
    host.id = 'ntut-ext-badge';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${BASE_CSS}
      .ui { position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; display: flex; gap: 10px;
        align-items: flex-start; max-width: 300px; padding: 12px 14px 12px 12px; border-radius: 12px;
        background: rgba(255,255,255,.92); backdrop-filter: blur(12px) saturate(1.4);
        border: 1px solid rgba(15,23,42,.08); border-left: 3px solid var(--accent);
        box-shadow: 0 1px 2px rgba(15,23,42,.06), 0 12px 32px -8px rgba(15,23,42,.22);
        animation: in .4s cubic-bezier(.16,1,.3,1); transition: opacity .3s, transform .3s; }
      .ui.out { opacity: 0; transform: translateY(8px); }
      .icon { margin-top: 1px; }
      .text { display: grid; gap: 3px; }
      .title { color: #0f172a; font-weight: 600; }
      .sub { font-size: 12px; font-weight: 400; color: #64748b; line-height: 1.45; white-space: pre-wrap; }
      @keyframes in { from { opacity: 0; transform: translateY(12px) scale(.97); } }
    </style>
    <div class="ui" role="status" aria-live="polite">
      <span class="icon"></span>
      <div class="text"><span class="title"></span><span class="sub" hidden></span></div>
    </div>`;
    document.body.appendChild(host);
    toast = { host, root };
    return toast;
  }

  // state: 'busy' | 'ok' | 'warn' | 'error'
  function badge(state, title, sub) {
    clearTimeout(toastTimer);
    if (statusBox) {
      if (toast) { toast.host.remove(); toast = null; }
      statusBox.host.dataset.state = state;
      render(statusBox.root, state, title, sub);
      return;
    }
    const t = getToast();
    t.host.dataset.state = state;
    t.root.querySelector('.ui').classList.remove('out');
    render(t.root, state, title, sub);
    if (state === 'ok') {
      toastTimer = setTimeout(() => {
        t.root.querySelector('.ui').classList.add('out');
        toastTimer = setTimeout(() => { t.host.remove(); if (toast === t) toast = null; }, 300);
      }, 4000);
    }
  }

  // Read the captcha already displayed on the page (no extra request to the
  // server — every request to authImage.do makes the server issue a new code).
  function imageBytes(img) {
    return new Promise((resolve, reject) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob(async (blob) => {
        if (!blob) return reject(new Error('無法讀取驗證碼圖片'));
        resolve(Array.from(new Uint8Array(await blob.arrayBuffer())));
      }, 'image/png');
    });
  }

  function ocr(bytes) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'ocr', bytes }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error(resp && resp.error || 'OCR failed'));
        resolve(resp.text);
      });
    });
  }

  // When the captcha is hidden, a result that isn't 4 letters gets a fresh image
  // (the server issues a new code for it) up to MAX_RETRIES times; after that the
  // captcha is shown so the user can type it.
  const MAX_RETRIES = 2;
  let retries = 0;
  function newCaptchaImage(img) {
    const u = new URL(img.src, location.href);
    u.searchParams.set('datetime', Date.now());
    img.src = u.href;
  }

  let runId = 0;
  async function fillCaptcha(img) {
    const code = $('#authcode');
    if (!code || !img.complete || !img.naturalWidth) return;
    const id = ++runId;
    try {
      badge('busy', statusBox ? '驗證中' : '辨識驗證碼中');
      const text = await ocr(await imageBytes(img));
      if (id !== runId) return; // a newer captcha image replaced this one
      code.value = text;
      code.dispatchEvent(new Event('input', { bubbles: true }));
      code.dispatchEvent(new Event('change', { bubbles: true }));
      if (text.length === 4) {
        retries = 0;
        badge('ok', statusBox ? '已驗證' : '驗證碼已自動填入', statusBox ? '自動辨識' : text);
      } else if (hiddenEls.length && retries < MAX_RETRIES) {
        retries++;
        badge('busy', '驗證中', '重試 ' + retries + '/' + MAX_RETRIES);
        newCaptchaImage(img);
      } else {
        showCaptcha();
        badge('warn', '請確認驗證碼', '辨識結果：' + (text || '（空白）') + '\n可修正，或按「更新驗證碼」換一張');
      }
    } catch (e) {
      showCaptcha();
      badge('error', '無法自動辨識，請手動輸入', e.message);
    }
  }

  // Keep-alive ping from the background: request myPortal.do same-origin so the
  // session cookie is always sent, and report whether we're still logged in.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'keepalive-ping') {
      fetch('/myPortal.do', { credentials: 'include', cache: 'no-store' })
        .then((r) => r.text())
        .then((t) => sendResponse({
          ok: true,
          expired: t.includes('請重新登入') || t.includes('name="login"') || t.includes('id="muid"'),
        }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
  });

  async function main() {
    const img = document.getElementById('authImage');
    if (!img || !$('#authcode')) {
      showCaptcha();
      // Not the login page — if it's a logged-in page, tell the keep-alive.
      if (!document.title.includes('請重新登入')) {
        chrome.runtime.sendMessage({ type: 'portal-seen' });
      }
      return;
    }

    const { captchaEnabled, hideCaptcha: hide } = await settings;
    if (captchaEnabled === false || hide === false) showCaptcha();
    if (captchaEnabled === false) return;
    if (hide !== false) hideCaptcha(img, $('#authcode'));

    // Re-run whenever the image changes (e.g. the user clicks 「更新驗證碼」).
    img.addEventListener('load', () => fillCaptcha(img));
    if (img.complete && img.naturalWidth) fillCaptcha(img);
  }

  // Runs at document_start: start hiding right away if both options are on.
  const settings = chrome.storage.local.get(['captchaEnabled', 'hideCaptcha']);
  settings.then((s) => { if (s.captchaEnabled !== false && s.hideCaptcha !== false) earlyHide(); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
