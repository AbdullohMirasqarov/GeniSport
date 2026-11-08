"""Browser-level repro: two separate users via two headless Chrome profiles.

Uses Chrome DevTools Protocol to:
  * register two users (different profiles = different localStorage)
  * host creates room, guest enters code + clicks "Join Room"
  * listen for page navigations (reload!), console errors, JS exceptions,
    and WebSocket open/close
Failures are reported with a verdict instead of silent passes.
"""
import asyncio
import json
import os
import subprocess
import sys
import urllib.request

import websockets

BASE = "http://127.0.0.1:8017"
CHROME = next(p for p in (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
) if os.path.exists(p))

NOW = asyncio.get_event_loop().time() if hasattr(asyncio.get_event_loop(), "time") else 0


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.mid = 0
        self.responses = {}
        self.events = []
        self.javascript_errors = []
        self.navigations = []
        self.ws_events = []
        self.pump = asyncio.create_task(self._pump())

    async def _pump(self):
        try:
            async for raw in self.ws:
                data = json.loads(raw)
                if "id" in data:
                    self.responses[data["id"]] = data
                else:
                    self.events.append(data)
                    m, p = data.get("method"), data.get("params", {})
                    if m == "Runtime.exceptionThrown":
                        d = p.get("exceptionDetails", {})
                        self.javascript_errors.append(
                            d.get("exception", {}).get("description")
                            or d.get("text") or str(d))
                    elif m == "Log.entryAdded":
                        e = p.get("entry", {})
                        if e.get("level") in ("error",):
                            self.javascript_errors.append(e.get("text"))
                    elif m in ("Page.frameStartedLoading", "Page.frameNavigated"):
                        url = p.get("frame", {}).get("url", "")
                        self.navigations.append((m, url))
                    elif m.startswith("Network.webSocket"):
                        self.ws_events.append(m)
        except websockets.ConnectionClosed:
            pass

    async def call(self, method, params=None):
        self.mid += 1
        mid = self.mid
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        for _ in range(500):
            if mid in self.responses:
                return self.responses.pop(mid)
            await asyncio.sleep(0.02)
        raise TimeoutError(method)

    async def enable(self):
        for m in ("Page.enable", "Runtime.enable", "Network.enable", "Log.enable"):
            await self.call(m)

    async def eval(self, expr):
        out = await self.call("Runtime.evaluate", {
            "expression": expr, "awaitPromise": True, "returnByValue": True,
        })
        result = out.get("result", {}).get("result", {})
        if "exceptionDetails" in out.get("result", {}):
            d = out["result"]["exceptionDetails"]
            self.javascript_errors.append(d.get("exception", {}).get("description") or d.get("text"))
        return result.get("value")

    def filter(self, since):
        nav = self.navigations[since["nav"]:]
        errs = self.javascript_errors[since["err"]:]
        wse = self.ws_events[since["ws"]:]
        return nav, errs, wse

    def cursor(self):
        return {"nav": len(self.navigations), "err": len(self.javascript_errors), "ws": len(self.ws_events)}

    async def close(self):
        self.pump.cancel()
        await self.ws.close()


async def cdp_page(port):
    raw = urllib.request.urlopen(f"http://127.0.0.1:{port}/json").read()
    targets = json.loads(raw.decode())
    page = next(t for t in targets if t["type"] == "page")
    ws = await websockets.connect(page["webSocketDebuggerUrl"])
    c = CDP(ws)
    await c.enable()
    return c


LOGIN_JS = """
(async () => {
  const body = { username: 'adra%d', password: 'hunter2', weight_kg: 70 };
  let res = await fetch('/api/auth/register', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status !== 201) {
    res = await fetch('/api/auth/login', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: body.username, password: body.password }) });
  }
  const data = await res.json();
  localStorage.setItem('genisport_token', data.access_token);
  // Reload so App.boot() picks the session up through the app's own flow.
  location.hash = '#/battle';
  location.reload();
  return 'token-set-reloading';
})()
"""


def report(stage, c, cursor, ok_label):
    nav, errs, wse = c.filter(cursor)
    problems = [n for n in errs if "favicon" not in (n or "").lower()]
    print(f"[{stage}] navigations={nav} ws_events={len(wse)}")
    if problems:
        print("      JS errors:", problems[:3])
    return len(problems)


async def main():
    procs = []
    cdps = []
    ports = (9231, 9232)
    for i, port in enumerate(ports):
        profile = rf"C:\Users\User\AppData\Local\Temp\gs_cdp_{i}_new" 
        procs.append(subprocess.Popen([
            CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
            "--no-default-browser-check", f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}", "--autoplay-policy=no-user-gesture-required",
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "about:blank",
        ]))
    await asyncio.sleep(3)
    try:
        cA = await cdp_page(ports[0])
        cB = await cdp_page(ports[1])
        cdps = [cA, cB]

        await cA.call("Page.navigate", {"url": BASE + "/"})
        await cB.call("Page.navigate", {"url": BASE + "/"})
        await asyncio.sleep(2.5)

        # Register two distinct users in each profile, then let the app boot.
        assert await cA.eval(LOGIN_JS % 1) == "token-set-reloading", "user A register/login"
        assert await cB.eval(LOGIN_JS % 2) == "token-set-reloading", "user B register/login"
        await asyncio.sleep(2.5)  # wait for the reload + boot

        curA, curB = cA.cursor(), cB.cursor()

        # HOST: click Generate Room.
        code = await cA.eval("""
          document.getElementById('btn-battle-create').click();
          (async () => {
            const lobby = document.getElementById('battle-lobby');
            const el = document.getElementById('battle-code-display');
            for (let i = 0; i < 80; i++) {
              // Real room: lobby visible AND placeholder replaced.
              if (!lobby.hidden && el.textContent.startsWith('GS-') &&
                  el.textContent !== 'GS-0000') return el.textContent;
              await new Promise(r => setTimeout(r, 100));
            }
            return 'no-code:' + lobby.hidden + ':' + el.textContent;
          })()
        """)
        if isinstance(code, dict):
            code = str(code)
        print("host room code:", code)
        assert isinstance(code, str) and code.startswith("GS-"), code

        # GUEST: type code + click Join Room.
        await cB.eval(f"""
          document.getElementById('battle-join-code').value = {json.dumps(code)};
          document.getElementById('btn-battle-join').click();
          'clicked'
        """)
        await asyncio.sleep(1.5)
        report("after host create", cA, curA, "")
        report("after guest join", cB, curB, "")

        # Verify both lobbies show both players staying put.
        await asyncio.sleep(4)
        host_view = await cA.eval("document.getElementById('slot-guest-name').textContent")
        guest_view = await cB.eval("document.getElementById('slot-host-name').textContent")
        print("host lobby shows guest as:", host_view)
        print("guest lobby shows host as:", guest_view)

        still_connects = await cB.eval("""
          (async () => {
            if (!window.WebSocket) return 'n/a';
            return Battle.ws ? String(Battle.ws.readyState) : 'no-ws';
          })()
        """)
        print("guest Battle.ws.readyState:", still_connects)

        # ---- Full lifecycle: both players ready -> countdown -> arena ----
        # High-frequency samplers: record every countdown tick message AND every
        # rendered countdown number + banner value, locally in each page.
        SAMPLER_JS = """(() => {
          window.__cdSeq = [];
          window.__samples = [];
          if (!Battle.__origHandle) {
            Battle.__origHandle = Battle.handle.bind(Battle);
            Battle.handle = (m) => {
              if (m.type === 'countdown') window.__cdSeq.push(m.seconds);
              return Battle.__origHandle(m);
            };
          }
          clearInterval(window.__sampler);
          window.__sampler = setInterval(() => {
            const cd = document.getElementById('battle-countdown');
            const cdNum = document.getElementById('battle-countdown-num');
            window.__samples.push({
              t: Date.now(),
              cd: (!cd || cd.hidden) ? null : cdNum.textContent,
              banner: document.getElementById('battle-banner-main').textContent,
              status: Battle.status,
              timer: Battle._countdownTimer,   // must stay null — no local ticker
            });
          }, 100);
          return 'sampler-on';
        })()"""
        print("host sampler:", await cA.eval(SAMPLER_JS))
        print("guest sampler:", await cB.eval(SAMPLER_JS))
        await cA.eval("document.getElementById('btn-battle-ready').click(); 'readyA'")
        await cB.eval("document.getElementById('btn-battle-ready').click(); 'readyB'")
        await asyncio.sleep(5.5)  # countdown is 3-2-1

        arenaA = await cA.eval("!document.getElementById('battle-arena').hidden")
        arenaB = await cB.eval("!document.getElementById('battle-arena').hidden")
        bannerA = await cA.eval("document.getElementById('battle-banner-main').textContent")
        print("host arena visible:", arenaA, "banner:", bannerA)
        print("guest arena visible:", arenaB)
        assert arenaA and arenaB, "both players must reach the live arena"

        # Both sockets must still be exchangeable after battle_start.
        live_a = await cA.eval("Battle.ws && Battle.ws.readyState")
        live_b = await cB.eval("Battle.ws && Battle.ws.readyState")
        print("sockets after battle_start — host:", live_a, "guest:", live_b)
        assert str(live_a) == "1" and str(live_b) == "1", "sockets must stay open during the match"

        # ---- Bug-fix assertions: arena state during the live match ----
        state_js = """(() => ({
          oppName: document.getElementById('battle-opp-name').textContent,
          oppAvatar: document.getElementById('battle-opp-avatar').textContent,
          overlayHidden: document.getElementById('battle-overlay').hidden,
          overlayDisplay: getComputedStyle(document.getElementById('battle-overlay')).display,
          mediaState: Battle._mediaState,
          videoVisible: document.getElementById('bvideo').classList.contains('visible'),
          status: Battle.status,
          banner: document.getElementById('battle-banner-main').textContent,
          camErrShown: !document.getElementById('battle-cam-error').hidden,
        }))()"""
        host_state = await cA.eval(state_js)
        guest_state = await cB.eval(state_js)
        print("HOST arena state:", json.dumps(host_state))
        print("GUEST arena state:", json.dumps(guest_state))

        # Bug 2: the host must see the guest's real username, never "?" / "Opponent".
        assert host_state["oppName"] == "adra2", f"host arena shows {host_state['oppName']!r}, expected 'adra2'"
        assert host_state["oppAvatar"] == "A", host_state
        assert guest_state["oppName"] == "adra1", f"guest arena shows {guest_state['oppName']!r}, expected 'adra1'"

        # Bug 1: while the timer ticks, the waiting overlay must be gone and the
        # camera tracker must be live.
        assert host_state["overlayDisplay"] == "none", "waiting overlay still covers the live arena on host"
        assert guest_state["overlayDisplay"] == "none", "waiting overlay still covers the live arena on guest"
        assert host_state["mediaState"] == "running" and host_state["videoVisible"], "host camera tracker not live"
        assert guest_state["mediaState"] == "running" and guest_state["videoVisible"], "guest camera tracker not live"
        assert not host_state["camErrShown"], "cam-error must not show while camera works"
        await asyncio.sleep(1.2)
        host_later = await cA.eval(state_js)
        assert host_later["banner"] != host_state["banner"], "timer must tick while overlay is hidden"

        # Camera-failure drill: kill getUserMedia mid-match — the arena must
        # stay active with the friendly fallback, never freeze behind a glove screen.
        fallback = await cA.eval("""(async () => {
          navigator.mediaDevices.getUserMedia = () =>
            Promise.reject(new DOMException('cam busy', 'NotReadableError'));
          Battle._mediaState = null;   // simulate a start that never happened
          Battle._startMedia(true);
          await new Promise(r => setTimeout(r, 900));
          return {
            status: Battle.status,
            mediaState: Battle._mediaState,
            errShown: !document.getElementById('battle-cam-error').hidden,
            errMsg: document.getElementById('battle-cam-error').textContent.trim(),
            overlayDisplay: getComputedStyle(document.getElementById('battle-overlay')).display,
            ws: Battle.ws ? Battle.ws.readyState : null,
          };
        })()""")
        print("HOST camera-failure fallback:", json.dumps(fallback))
        assert fallback["status"] == "active", "match must stay active when the camera fails"
        assert fallback["mediaState"] == "failed", fallback
        assert fallback["errShown"] and "busy or unavailable" in fallback["errMsg"].lower(), fallback
        assert fallback["overlayDisplay"] == "none", "glove overlay must not cover the arena after camera failure"
        assert str(fallback["ws"]) == "1", "socket must stay open after camera failure"

        # ---- Countdown smoothness & timer-sync assertions (bug report: 3-3-3 / 1-1-1-1) ----
        def parse_banner(txt):
            m, s = str(txt).split(":")
            return int(m) * 60 + int(s)

        def collapse(seq):
            out = []
            for v in seq:
                if not out or out[-1] != v:
                    out.append(v)
            return out

        grab = "JSON.stringify({seq: window.__cdSeq, samples: window.__samples})"
        dataA = json.loads(await cA.eval(grab))
        dataB = json.loads(await cB.eval(grab))
        print("host countdown tick messages:", dataA["seq"])
        print("guest countdown tick messages:", dataB["seq"])

        # 1) Exactly one server tick per second value, in order — no duplicates.
        assert dataA["seq"] == [3, 2, 1], f"host tick sequence {dataA['seq']} != [3, 2, 1]"
        assert dataB["seq"] == [3, 2, 1], f"guest tick sequence {dataB['seq']} != [3, 2, 1]"

        # 2) The rendered DOM numbers follow a smooth, non-repeating 3 -> 2 -> 1.
        for label, data in (("host", dataA), ("guest", dataB)):
            shown = [s["cd"] for s in data["samples"] if s["cd"] is not None]
            dom_seq = collapse(shown)
            print(f"{label} rendered countdown transitions:", dom_seq)
            assert dom_seq == ["3", "2", "1"], f"{label} DOM countdown stuttered: {dom_seq}"
            # 3) No local countdown interval ever existed (server-driven only).
            assert all(s["timer"] is None for s in data["samples"]), f"{label} ran a local countdown ticker"
            # Overlay must be gone once the match is active.
            active = [s for s in data["samples"] if s["status"] == "active"]
            assert active and all(s["cd"] is None for s in active[-5:]), f"{label} overlay survived battle_start"

        # 4) Synchronized match clock: nearest-sample banner skew <= 1s.
        actA = [(s["t"], parse_banner(s["banner"])) for s in dataA["samples"]
                if s["status"] == "active" and ":" in str(s["banner"])]
        actB = [(s["t"], parse_banner(s["banner"])) for s in dataB["samples"]
                if s["status"] == "active" and ":" in str(s["banner"])]
        assert actA and actB, "need active-phase banner samples on both screens"
        worst = 0.0
        for ta, va in actA:
            tb, vb = min(actB, key=lambda p: abs(p[0] - ta))
            worst = max(worst, abs(va - vb))
        print(f"banner clock skew host-vs-guest: {worst:.2f}s (must be <= 1)")
        assert worst <= 1.0, f"arena timers desynchronized by {worst:.2f}s"

        navA, errA, _ = cA.filter(curA)
        navB, errB, _ = cB.filter(curB)
        badA = [n for n in navA if n[1].rstrip("/") == BASE and "loading" in n[0].lower() or "frameNavigated" in n[0]]
        badB = [n for n in navB if n[1].rstrip("/") == BASE and ("frameNavigated" in n[0] or "loading" in n[0].lower())]
        print("verdict:")
        print("  reload on host page:", badA or "NONE (no reload)")
        print("  reload on guest page:", badB or "NONE (no reload)")
        for label, errs in (("host", errA), ("guest", errB)):
            errs = [e for e in errs if e and "favicon" not in e.lower()]
            print(f"  {label} JS errors:", errs[:4] if errs else "NONE")

        if badA or badB:
            print("\nREPRODUCED: page reload detected during battle join!")
            raise SystemExit(2)
        if (str(still_connects) not in ("1",) and host_view and "adra2" not in str(host_view)):
            print("\nSOFT WARNING: guest socket or slots not in expected state")
        print("\nVERDICT: no reload reproduced in real browsers — lobby survives guest join")
    finally:
        for c in cdps:
            try:
                asyncio.get_event_loop().call_soon(c.pump.cancel)
            except Exception:
                pass
        for p in procs:
            p.kill()


if __name__ == "__main__":
    asyncio.run(main())
