"""End-to-end test: loads the extension in a real Chrome/Chromium and checks it
against a mock of the NTUT login page.

The mock server behaves like the real one: every request to authImage.do issues
a NEW captcha code, so the test catches bugs where the extension recognizes one
image while the server expects another.

    pip install playwright && python -m playwright install chromium
    python tests/e2e_test.py              # uses Playwright's Chromium
    CHROME_PATH=/path/to/chrome python tests/e2e_test.py
"""
import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = str(ROOT / "ntut-ext")
SAMPLES = ROOT / "tests" / "samples"
# Sample file names are the correct answers (uppercase; output must match exactly).
IMAGES = sorted(SAMPLES.glob("*.png"))

LOGIN_PAGE = """<html><head><title>臺北科技大學</title><script>
function login1(){ document.title='SUBMITTED'; }
function refreshAuthImage(){ document.getElementById('authImage').src='authImage.do?datetime='+Date.now(); }
</script></head><body><form name="login" onsubmit="login1();return false;">
<table><tr><td>帳號</td><td><input id="muid"></td></tr>
<tr><td>密碼</td><td><input type="password" id="mpassword"></td></tr>
<tr id="captchaRow"><td>驗證碼</td><td><input id="authcode">
<img id="authImage" src="authImage.do?datetime=1">
<a href="javascript:refreshAuthImage()">更新驗證碼</a></td></tr>
<tr><td><input type="submit" value="登入"></td></tr></table></form></body></html>"""

def _blank_png(w=135, h=39):
    """Plain white PNG (OCR finds no letters), built with the stdlib only."""
    import struct, zlib
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    raw = b"".join(b"\x00" + b"\xff" * (w * 3) for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


BLANK_PNG = _blank_png()

failures = 0


def check(ok, msg):
    global failures
    print(("PASS" if ok else "FAIL"), "-", msg)
    if not ok:
        failures += 1


def launch(p, profile):
    args = ["--headless=new", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
            # Branded Chrome 137+ ignores --load-extension unless this is set.
            "--disable-features=DisableLoadExtensionCommandLineSwitch"]
    kwargs = dict(headless=True, args=args)
    if os.environ.get("CHROME_PATH"):
        kwargs["executable_path"] = os.environ["CHROME_PATH"]
    return p.chromium.launch_persistent_context(profile, **kwargs)


async def service_worker(ctx):
    return ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")


async def main():
    profile = tempfile.mkdtemp(prefix="ntut-ext-test-")
    state = {"n": 0, "current": None, "blank": False}
    try:
        async with async_playwright() as p:
            # 1) Credentials saved by older versions must be deleted on startup.
            ctx = await launch(p, profile)
            sw = await service_worker(ctx)
            await sw.evaluate("chrome.storage.local.set({account:'x',password:'y',autoLogin:true})")
            await ctx.close()
            ctx = await launch(p, profile)
            sw = await service_worker(ctx)
            await asyncio.sleep(1)
            left = await sw.evaluate("chrome.storage.local.get(null)")
            check(not any(k in left for k in ("account", "password", "autoLogin")),
                  "credentials from older versions are purged")

            # 2) OCR through the real message path: page -> service worker -> offscreen document.
            ext_id = sw.url.split("/")[2]
            popup = await ctx.new_page()
            await popup.goto(f"chrome-extension://{ext_id}/popup.html")
            for img in IMAGES:
                resp = await popup.evaluate(
                    "(b) => chrome.runtime.sendMessage({type:'ocr', bytes:b})", list(img.read_bytes()))
                check(resp.get("ok") and resp["text"] == img.stem,
                      f"OCR {img.name}: got {resp.get('text') or resp.get('error')}")

            # 3) Login page flow against a server that rotates the code on every image request.
            async def route(r):
                url = r.request.url
                if "authImage.do" in url and state["blank"]:
                    state["n"] += 1
                    await r.fulfill(body=BLANK_PNG, content_type="image/png")
                elif "authImage.do" in url:
                    img = IMAGES[state["n"] % len(IMAGES)]
                    state["n"] += 1
                    state["current"] = img.stem
                    await r.fulfill(body=img.read_bytes(), content_type="image/png")
                elif "myPortal.do" in url:
                    await r.fulfill(body="<title>portal</title>", content_type="text/html")
                else:
                    await r.fulfill(body=LOGIN_PAGE, content_type="text/html; charset=utf-8")

            await ctx.route("https://nportal.ntut.edu.tw/**", route)
            page = await ctx.new_page()
            await page.goto("https://nportal.ntut.edu.tw/index.do")
            await page.wait_for_function("authcode.value.length > 0", timeout=60000)
            v = await page.evaluate("({code: authcode.value, muid: muid.value, pwd: mpassword.value, title: document.title})")
            check(v["code"] == state["current"],
                  f"filled captcha matches the server's current code ({v['code']} vs {state['current']})")
            check(state["n"] == 1, f"no extra captcha requests (requests={state['n']})")
            check(v["muid"] == "" and v["pwd"] == "", "account/password fields untouched")
            check(v["title"] != "SUBMITTED", "form is not auto-submitted")
            await page.wait_for_function("document.getElementById('ntut-ext-status')?.dataset.state === 'ok'", timeout=10000)
            check(not await page.is_visible("#authcode") and not await page.is_visible("#authImage"),
                  "captcha row is hidden")
            check(await page.is_visible("#muid") and await page.is_visible("#mpassword"),
                  "account/password fields stay visible")

            await page.evaluate("refreshAuthImage()")
            expected = IMAGES[1 % len(IMAGES)].stem
            await page.wait_for_function(f"authcode.value === '{expected}'", timeout=60000)
            check(state["n"] == 2, "after refreshing the captcha, the new image is recognized")

            # 4) Clicking the eye button reveals the captcha.
            await page.click("#ntut-ext-status button")
            check(await page.is_visible("#authcode") and await page.is_visible("#authImage"),
                  "clicking the eye button reveals the captcha")

            # 5) Unreadable captcha: retry with new images twice, then show it to the user.
            state["blank"] = True
            state["n"] = 0
            page2 = await ctx.new_page()
            await page2.goto("https://nportal.ntut.edu.tw/index.do")
            await page2.wait_for_selector("#authcode", state="visible", timeout=60000)
            check(state["n"] == 3, f"unreadable captcha: 2 retries before showing it (requests={state['n']})")

            # 6) Popup saves the hide option; with hiding off the captcha stays visible
            #    and is still filled in.
            await popup.reload()
            await popup.wait_for_load_state()
            await asyncio.sleep(0.5)  # popup.js fills the checkboxes from storage asynchronously
            check(await popup.is_checked("#hideCaptcha"), "popup: hide option defaults to on")
            await popup.uncheck("#hideCaptcha")
            await popup.click("#save")
            saved = await sw.evaluate("chrome.storage.local.get('hideCaptcha')")
            check(saved.get("hideCaptcha") is False, "popup: hide option is saved")
            state["blank"] = False
            page3 = await ctx.new_page()
            await page3.goto("https://nportal.ntut.edu.tw/index.do")
            await page3.wait_for_function("authcode.value.length === 4", timeout=60000)
            check(await page3.is_visible("#authcode") and await page3.is_visible("#authImage")
                  and await page3.evaluate("!document.getElementById('ntut-ext-status')"),
                  "hiding off: captcha visible and filled, no inline status")
            await ctx.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    print(f"\n{'All tests passed' if failures == 0 else f'{failures} test(s) failed'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
