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
# Sample file names are the correct answers (case-insensitive).
IMAGES = sorted(SAMPLES.glob("*.png"))

LOGIN_PAGE = """<html><head><title>臺北科技大學</title><script>
function login1(){ document.title='SUBMITTED'; }
function refreshAuthImage(){ document.getElementById('authImage').src='authImage.do?datetime='+Date.now(); }
</script></head><body><form name="login" onsubmit="login1();return false;">
<input id="muid"><input type="password" id="mpassword"><input id="authcode">
<img id="authImage" src="authImage.do?datetime=1"></form></body></html>"""

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
    state = {"n": 0, "current": None}
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
                check(resp.get("ok") and resp["text"].lower() == img.stem.lower(),
                      f"OCR {img.name}: got {resp.get('text') or resp.get('error')}")

            # 3) Login page flow against a server that rotates the code on every image request.
            async def route(r):
                url = r.request.url
                if "authImage.do" in url:
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
            check(v["code"].lower() == state["current"].lower(),
                  f"filled captcha matches the server's current code ({v['code']} vs {state['current']})")
            check(state["n"] == 1, f"no extra captcha requests (requests={state['n']})")
            check(v["muid"] == "" and v["pwd"] == "", "account/password fields untouched")
            check(v["title"] != "SUBMITTED", "form is not auto-submitted")

            await page.evaluate("refreshAuthImage()")
            expected = IMAGES[1 % len(IMAGES)].stem.lower()
            await page.wait_for_function(f"authcode.value.toLowerCase() === '{expected}'", timeout=60000)
            check(state["n"] == 2, "after refreshing the captcha, the new image is recognized")
            await ctx.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    print(f"\n{'All tests passed' if failures == 0 else f'{failures} test(s) failed'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
