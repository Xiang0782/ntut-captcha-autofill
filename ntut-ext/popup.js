const $ = (id) => document.getElementById(id);

const KEYS = ['captchaEnabled', 'keepAlive', 'keepAliveMinutes', 'keepAliveStatus'];

function renderStatus(st) {
  const el = $('kaStatus');
  if (!st) { el.textContent = '保持連線狀態：尚未檢查'; el.style.color = '#555'; return; }
  const t = new Date(st.time).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  if (st.state === 'alive') {
    el.textContent = `保持連線狀態：已登入 ✓（${t} 檢查）`; el.style.color = '#16a34a';
  } else if (st.state === 'expired') {
    el.textContent = `保持連線狀態：未登入／已登出（${t} 檢查）`; el.style.color = '#b91c1c';
  } else {
    el.textContent = `保持連線狀態：檢查失敗（${t}）${st.error ? '：' + st.error : ''}`; el.style.color = '#d97706';
  }
}

chrome.storage.local.get(KEYS).then((s) => {
  $('captchaEnabled').checked = s.captchaEnabled !== false;
  $('keepAlive').checked = s.keepAlive !== false;
  $('keepAliveMinutes').value = s.keepAliveMinutes || 10;
  renderStatus(s.keepAliveStatus);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.keepAliveStatus) renderStatus(changes.keepAliveStatus.newValue);
});

$('save').addEventListener('click', async () => {
  const keepAliveMinutes = Math.min(25, Math.max(1, parseInt($('keepAliveMinutes').value, 10) || 10));
  await chrome.storage.local.set({
    captchaEnabled: $('captchaEnabled').checked,
    keepAlive: $('keepAlive').checked,
    keepAliveMinutes,
  });
  $('status').textContent = '已儲存 ✓';
  setTimeout(() => ($('status').textContent = ''), 1500);
  if ($('keepAlive').checked) chrome.runtime.sendMessage({ type: 'keepalive-now' });
});

$('go').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://nportal.ntut.edu.tw/index.do' });
});
