# ntut-captcha-autofill

北科大入口網站（[nportal.ntut.edu.tw](https://nportal.ntut.edu.tw)）驗證碼自動辨識填入的 Chrome 擴充功能，另附「維持登入」，避免閒置 30 分鐘被登出。

A Chrome extension that recognizes and fills in the captcha on the NTUT (National Taipei University of Technology) portal login page, entirely on-device. It also keeps your session alive so the portal doesn't log you out after 30 idle minutes.

> 非官方專案，與國立臺北科技大學無關。 / Unofficial; not affiliated with NTUT.

## 功能

- **驗證碼自動填入**：開啟登入頁時自動辨識並填入驗證碼；按「更新驗證碼」換圖後會重新辨識。
- **隱藏驗證碼**（預設開啟，可在設定關閉）：驗證碼欄位換成「已驗證」狀態元件，點右側眼睛圖示可看原本的驗證碼。辨識結果不是 4 個字母時會自動換圖重試 2 次，仍失敗才顯示驗證碼讓你手動輸入。
- **維持登入**：每隔 N 分鐘（預設 10 分鐘，可設 1–25）請求一次入口網站頁面，重設伺服器的閒置計時；登入狀態可在設定視窗查看，掉線時工具列圖示顯示紅色「!」。
- **不碰帳號密碼**：不讀取、不儲存、不自動送出帳號密碼。帳密請自行輸入，或交給瀏覽器的密碼管理員。
- **完全在本機執行**：辨識使用內建的 OCR 模型，在瀏覽器裡用 WebAssembly 推論，驗證碼圖片不會傳送到任何外部伺服器。

## 安裝

1. 下載本專案：按 GitHub 頁面上的 **Code → Download ZIP** 並解壓縮，或 `git clone https://github.com/Xiang0782/ntut-captcha-autofill.git`
2. Chrome 網址列輸入 `chrome://extensions`，開啟右上角的「開發人員模式」
3. 點「載入未封裝項目」，選擇專案裡的 **`ntut-ext`** 資料夾（不是專案根目錄）

模型檔 `ntut-ext/model.onnx` 約 54 MB，屬正常大小。

## 使用

打開 https://nportal.ntut.edu.tw/index.do ，驗證碼欄位會自動填好並顯示「已驗證」；輸入帳號密碼後按登入即可。點工具列圖示可以開關驗證碼自動填入，以及設定維持登入。

如果驗證碼錯了，按「更新驗證碼」換一張就會重新辨識。

## 運作方式

| 元件 | 作用 |
|------|------|
| `content.js` | 在登入頁把已顯示的驗證碼圖片畫到 canvas 取出像素，交給背景辨識，再填入欄位。直接讀已顯示的圖片，不另外請求驗證碼：伺服器每收到一次請求就會換一組驗證碼，多請求一次就會對不上。 |
| `background.js` | Service Worker。把辨識請求轉給 offscreen document，並用 `chrome.alarms` 排程維持登入。 |
| `offscreen.html/js` | 隱藏頁面，用 onnxruntime-web 跑 OCR 模型。onnxruntime-web 需要動態 `import()`，而 Chrome 不允許 Service Worker 使用，所以放在這裡。 |
| `popup.html/js` | 設定介面。 |

辨識流程：灰階化 → 以亮度 150 二值化（去掉淺色干擾線與背景）→ 等比例縮放到高 64 px → 模型推論 → CTC 解碼。解碼時每一步只在「空白＋A–Z」中選，並把同一字母大小寫的機率合併，輸出一律為大寫；若結果不是 4 個字母，改用亮度 170、130 再試。

維持登入會優先從已開著的入口網站分頁送出請求（同源，一定帶得到 session cookie）；沒有分頁時才從背景送出。

## 權限說明

| 權限 | 用途 |
|------|------|
| `host_permissions: nportal.ntut.edu.tw` | 在登入頁執行、送出維持登入的請求 |
| `storage` | 儲存開關與維持登入的設定 |
| `alarms` | 定時維持登入 |
| `offscreen` | 建立執行 OCR 的隱藏頁面 |
| CSP `wasm-unsafe-eval` | 允許執行 WebAssembly（OCR 推論需要） |

## 開發與測試

測試會在真的 Chrome／Chromium 載入擴充功能，對一個模擬的登入頁跑完整流程。模擬伺服器跟北科一樣，每次請求驗證碼都換一組新的。

```bash
pip install playwright
python -m playwright install chromium
python tests/e2e_test.py
# 或指定 Chrome：CHROME_PATH=/path/to/chrome python tests/e2e_test.py
```

`tests/samples/` 裡的驗證碼圖片以正確答案命名，可以自行加入更多樣本來評估辨識準確率。

## 限制

- 若入口網站改版（欄位 id、驗證碼樣式或登入流程改變），擴充功能可能需要更新。
- 電腦睡眠或 Chrome 關閉時無法維持登入。
- 從入口網站連進去的其他子系統（例如選課系統）各有自己的登入狀態，不在維持登入的範圍內。
- 請依學校的資訊使用規範使用本工具。

## 授權

[MIT](LICENSE)。內含的第三方元件（ddddocr OCR 模型、ONNX Runtime Web）皆為 MIT 授權，詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
