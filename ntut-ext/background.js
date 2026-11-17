// Service worker. The OCR itself runs in an offscreen document (offscreen.js);
// this file relays OCR requests to it and runs the keep-alive scheduler.

const OFFSCREEN_PATH = 'offscreen.html';
let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url],
  });
  if (contexts.length > 0) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS'],
    justification: 'Run on-device captcha OCR with onnxruntime-web (WebAssembly).',
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ocr') {
    (async () => {
      await ensureOffscreen();
      return chrome.runtime.sendMessage({ type: 'offscreen-ocr', bytes: msg.bytes });
    })()
      .then((resp) => sendResponse(resp || { ok: false, error: 'no response from OCR page' }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async
  }
});

// ───────────────────────── Keep-alive (維持登入) ─────────────────────────
// The portal logs out after 30 min idle. Every N minutes we request an
// authenticated page (myPortal.do), which refreshes the server session.
// Preferred route: through an open nportal tab (same-origin, always sends the
// session cookie). Fallback: a direct fetch from this service worker.

const PORTAL_URL = 'https://nportal.ntut.edu.tw/myPortal.do';
const ALARM = 'ntut-keepalive';
const DEFAULT_MINUTES = 10;

function isLoggedOutPage(text) {
  return text.includes('請重新登入') || text.includes('name="login"') || text.includes('id="muid"');
}

async function getKeepAliveSettings() {
  const s = await chrome.storage.local.get(
    ['keepAlive', 'keepAliveMinutes']);
  return {
    keepAlive: s.keepAlive !== false, // default on
    minutes: Math.min(25, Math.max(1, s.keepAliveMinutes || DEFAULT_MINUTES)),
  };
}

async function ensureAlarm() {
  const { keepAlive, minutes } = await getKeepAliveSettings();
  if (!keepAlive) {
    await chrome.alarms.clear(ALARM);
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const existing = await chrome.alarms.get(ALARM);
  if (!existing || existing.periodInMinutes !== minutes) {
    await chrome.alarms.create(ALARM, { delayInMinutes: minutes, periodInMinutes: minutes });
  }
}

async function pingViaTab() {
  const tabs = await chrome.tabs.query({ url: 'https://nportal.ntut.edu.tw/*' });
  for (const tab of tabs) {
    if (tab.discarded) continue;
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'keepalive-ping' });
      if (resp && resp.ok) return { expired: resp.expired, via: 'tab' };
    } catch (e) { /* tab has no content script yet; try the next one */ }
  }
  return null;
}

async function pingViaFetch() {
  const res = await fetch(PORTAL_URL, { credentials: 'include', cache: 'no-store' });
  const text = await res.text();
  return { expired: isLoggedOutPage(text), via: 'background' };
}

async function keepAlive() {
  const settings = await getKeepAliveSettings();
  if (!settings.keepAlive) return;

  const { keepAliveStatus } = await chrome.storage.local.get('keepAliveStatus');
  const wasAlive = keepAliveStatus && keepAliveStatus.state === 'alive';

  let result;
  try {
    result = (await pingViaTab()) || (await pingViaFetch());
  } catch (e) {
    await chrome.storage.local.set({
      keepAliveStatus: { time: Date.now(), state: 'error', error: String(e && e.message || e) },
    });
    return;
  }

  const state = result.expired ? 'expired' : 'alive';
  await chrome.storage.local.set({ keepAliveStatus: { time: Date.now(), state, via: result.via } });

  if (state === 'alive') {
    await chrome.action.setBadgeText({ text: '' });
  } else if (wasAlive) {
    // We were logged in and lost the session (e.g. the computer slept).
    await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
    await chrome.action.setBadgeText({ text: '!' });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) keepAlive();
});

// Earlier versions stored the account/password. This version never does:
// delete anything left over, every time the service worker starts.
const LEGACY_KEYS = ['account', 'password', 'autoLogin', 'maxRetries', 'autoRelogin', 'reloginAt'];
chrome.storage.local.remove(LEGACY_KEYS);

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());
ensureAlarm(); // alarms may not survive every restart; re-check on each SW start

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.keepAlive || changes.keepAliveMinutes)) ensureAlarm();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'portal-seen') {
    // A logged-in portal page loaded: record it right away.
    chrome.storage.local.set({ keepAliveStatus: { time: Date.now(), state: 'alive', via: 'page' } });
    chrome.action.setBadgeText({ text: '' });
  } else if (msg.type === 'keepalive-now') {
    keepAlive().then(() => sendResponse({ ok: true }));
    return true;
  }
});
