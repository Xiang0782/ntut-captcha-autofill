// Offscreen document: runs the captcha OCR (onnxruntime-web needs dynamic import(),
// which Chrome forbids inside the extension service worker).
import * as ort from './ort/ort.wasm.bundle.min.mjs';

ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
ort.env.wasm.numThreads = 1;          // avoid SharedArrayBuffer / cross-origin-isolation needs
ort.env.wasm.proxy = false;

let sessionPromise = null;
let charsetPromise = null;

function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const url = chrome.runtime.getURL('model.onnx');
      const buf = await (await fetch(url)).arrayBuffer();
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    })();
  }
  return sessionPromise;
}
function getCharset() {
  if (!charsetPromise) {
    charsetPromise = (async () => {
      const url = chrome.runtime.getURL('charset.json');
      return (await fetch(url)).json();
    })();
  }
  return charsetPromise;
}

// Decode PNG bytes -> grayscale, threshold, resize to height 64 (bilinear), normalize 0..1.
async function preprocess(bytes, threshold) {
  const blob = new Blob([bytes], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  const W = bmp.width, H = bmp.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, W, H);

  const gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    let v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (threshold != null) v = v < threshold ? 0 : 255;
    gray[i] = v;
  }

  const tH = 64, tW = Math.max(1, Math.round(W * (tH / H)));
  const out = new Float32Array(tW * tH);
  for (let y = 0; y < tH; y++) {
    const sy = (y + 0.5) * H / tH - 0.5;
    let y0 = Math.floor(sy); const fy = sy - y0; let y1 = y0 + 1;
    y0 = Math.min(Math.max(y0, 0), H - 1); y1 = Math.min(Math.max(y1, 0), H - 1);
    for (let x = 0; x < tW; x++) {
      const sx = (x + 0.5) * W / tW - 0.5;
      let x0 = Math.floor(sx); const fx = sx - x0; let x1 = x0 + 1;
      x0 = Math.min(Math.max(x0, 0), W - 1); x1 = Math.min(Math.max(x1, 0), W - 1);
      const a = gray[y0 * W + x0], b = gray[y0 * W + x1],
            c = gray[y1 * W + x0], d = gray[y1 * W + x1];
      out[y * tW + x] = ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy) / 255;
    }
  }
  return { data: out, W: tW, H: tH };
}

function ctcDecode(output, dims, charset) {
  const [a, b, c] = dims;
  let seq, classes, get;
  if (b === 1) { seq = a; classes = c; get = (s, k) => output[s * classes + k]; }
  else { seq = b; classes = c; get = (s, k) => output[s * classes + k]; }
  let last = -1; const chars = [];
  for (let s = 0; s < seq; s++) {
    let best = -Infinity, bi = 0;
    for (let k = 0; k < classes; k++) { const v = get(s, k); if (v > best) { best = v; bi = k; } }
    if (bi !== last && bi !== 0) chars.push(charset[bi] || '');
    last = bi;
  }
  return chars.join('');
}

async function recognize(bytes) {
  const session = await getSession();
  const charset = await getCharset();
  const pre = await preprocess(bytes, 150);
  const tensor = new ort.Tensor('float32', pre.data, [1, 1, pre.H, pre.W]);
  const res = await session.run({ [session.inputNames[0]]: tensor });
  const out = res[session.outputNames[0]];
  let text = ctcDecode(out.data, out.dims, charset);
  // NTUT captcha = letters only, case-insensitive. Keep a-z.
  text = text.replace(/[^a-zA-Z]/g, '');
  return text;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'offscreen-ocr') {
    recognize(new Uint8Array(msg.bytes))
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async
  }
});
