// Content script: recognizes the captcha shown on the login page and fills it in.
// It never reads, stores, or submits your account or password.
(function () {
  function $(s) { return document.querySelector(s); }

  function badge(text, color) {
    let el = document.getElementById('ntut-ext-badge');
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

  let runId = 0;
  async function fillCaptcha(img) {
    const code = $('#authcode');
    if (!code || !img.complete || !img.naturalWidth) return;
    const id = ++runId;
    try {
      badge('辨識驗證碼中…', '#2563eb');
      const text = await ocr(await imageBytes(img));
      if (id !== runId) return; // a newer captcha image replaced this one
      code.value = text;
      code.dispatchEvent(new Event('input', { bubbles: true }));
      code.dispatchEvent(new Event('change', { bubbles: true }));
      if (text.length === 4) {
        badge('驗證碼已自動填入：' + text, '#16a34a');
      } else {
        badge('辨識結果可能有誤：' + (text || '（空白）') + '\n可按「更新驗證碼」換一張', '#d97706');
      }
    } catch (e) {
      badge('驗證碼辨識失敗：' + e.message, '#b91c1c');
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
      // Not the login page — if it's a logged-in page, tell the keep-alive.
      if (!document.title.includes('請重新登入')) {
        chrome.runtime.sendMessage({ type: 'portal-seen' });
      }
      return;
    }

    const { captchaEnabled } = await chrome.storage.local.get('captchaEnabled');
    if (captchaEnabled === false) return;

    // Re-run whenever the image changes (e.g. the user clicks 「更新驗證碼」).
    img.addEventListener('load', () => fillCaptcha(img));
    if (img.complete && img.naturalWidth) fillCaptcha(img);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
