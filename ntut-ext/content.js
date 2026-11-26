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
  // While hidden, an inline box takes the captcha's place and shows the status
  // (「驗證中…」→「✓ 已驗證」). Clicking「顯示」reveals the real captcha.
  let statusBox = null;
  function makeStatusBox(anchor) {
    const box = document.createElement('span');
    box.id = 'ntut-ext-status';
    box.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:4px 10px;' +
      'border-radius:6px;font:13px/1.6 sans-serif;color:#fff;white-space:nowrap;';
    const text = document.createElement('span');
    const show = document.createElement('a');
    show.href = '#'; show.textContent = '顯示';
    show.style.cssText = 'color:#fff;text-decoration:underline;font-size:12px;';
    show.addEventListener('click', (e) => { e.preventDefault(); showCaptcha(); });
    box.append(text, show);
    // A hidden table row can't be replaced by a bare <span>: give it a row of its own.
    let holder = box;
    if (anchor.tagName === 'TR') {
      holder = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = Math.max(1, anchor.cells.length);
      td.appendChild(box); holder.appendChild(td);
    }
    anchor.parentNode.insertBefore(holder, anchor);
    return { holder, box, text };
  }

  function hideCaptcha(img, code) {
    addStyle('ntut-ext-hide', `.${HIDDEN_CLASS}{display:none!important}`);
    hiddenEls = captchaParts(img, code);
    hiddenEls.forEach((el) => el.classList.add(HIDDEN_CLASS));
    statusBox = makeStatusBox(hiddenEls.length === 1 ? hiddenEls[0] : code);
    document.getElementById(EARLY_STYLE_ID)?.remove();
  }
  function showCaptcha() {
    hiddenEls.forEach((el) => el.classList.remove(HIDDEN_CLASS));
    hiddenEls = [];
    if (statusBox) { statusBox.holder.remove(); statusBox = null; }
    document.getElementById(EARLY_STYLE_ID)?.remove();
  }

  // Status message: in the inline box while the captcha is hidden, otherwise in
  // a floating badge at the bottom-right.
  function badge(text, color) {
    let el = document.getElementById('ntut-ext-badge');
    if (statusBox) {
      statusBox.text.textContent = text;
      statusBox.box.style.background = color || '#2563eb';
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'ntut-ext-badge';
      el.style.cssText = 'position:fixed;z-index:999999;right:12px;bottom:12px;padding:8px 12px;' +
        'border-radius:8px;font:13px/1.4 sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);' +
        'max-width:260px;white-space:pre-wrap;';
      document.body.appendChild(el);
    }
    el.style.background = color || '#2563eb';
    el.textContent = text;
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
      badge(statusBox ? '驗證中…' : '辨識驗證碼中…', '#2563eb');
      const text = await ocr(await imageBytes(img));
      if (id !== runId) return; // a newer captcha image replaced this one
      code.value = text;
      code.dispatchEvent(new Event('input', { bubbles: true }));
      code.dispatchEvent(new Event('change', { bubbles: true }));
      if (text.length === 4) {
        retries = 0;
        badge(statusBox ? '✓ 已驗證' : '驗證碼已自動填入：' + text, '#16a34a');
      } else if (hiddenEls.length && retries < MAX_RETRIES) {
        retries++;
        badge('驗證中…（重試 ' + retries + '）', '#2563eb');
        newCaptchaImage(img);
      } else {
        showCaptcha();
        badge('辨識結果可能有誤：' + (text || '（空白）') + '\n請確認驗證碼，或按「更新驗證碼」換一張', '#d97706');
      }
    } catch (e) {
      showCaptcha();
      badge('驗證碼辨識失敗：' + e.message + '\n請手動輸入驗證碼', '#b91c1c');
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
