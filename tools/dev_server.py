#!/usr/bin/env python3
"""Serve the built Angular bundle on a test page and proxy /Thingworx to a development platform, signed in as Administrator.

  python tools/dev_server.py [--port 4300]

The platform comes from TWX_BASE (default http://localhost:8080/Thingworx) and the Administrator password from
TWX_ADMIN_PASSWORD or the file named by TWX_ADMIN_PASSWORD_FILE. Development only:
every request is sent with the Administrator's credentials, so never expose the port.
"""
import argparse, base64, http.server, os, urllib.error, urllib.parse, urllib.request
from single_write_http import SingleWriteHandler

PLATFORM_BASE = os.environ.get("TWX_BASE", "http://localhost:8080/Thingworx").rstrip("/")

# Forwards each request in one write: plain urllib added 40 ms to every proxied POST to a platform in Docker on Windows.
OPENER = urllib.request.build_opener(SingleWriteHandler)

BUNDLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ui", "dist", "explorer", "main.js")
PAGE = """<!doctype html><meta charset="utf-8"><title>Solution Explorer (dev)</title>
<body style="margin:0"><se-explorer base-url="/Thingworx" style="display:block;height:100vh"></se-explorer>
<script>
// Test hook: /?tab=entities&entity=CM.Provisioning&service=RegisterApplication&view=sequence
const element = document.querySelector("se-explorer");
for (const [name, value] of new URLSearchParams(location.search)) element.setAttribute(name === "tab" ? "start-tab" : name === "collection" ? "entity-collection" : name, value);
</script>
<script src="/main.js"></script></body>"""


class Handler(http.server.BaseHTTPRequestHandler):
    authorization = None
    session_cookie = None

    def do_GET(self):
        if self.path.split("?")[0] == "/":
            return self.reply(200, PAGE.encode(), "text/html")
        if self.path.split("?")[0] == "/main.js":
            with open(BUNDLE, "rb") as handle:
                return self.reply(200, handle.read(), "text/javascript")
        self.proxy()

    do_POST = proxy = lambda self: self.forward()

    def forward(self):
        if not self.path.startswith("/Thingworx/"):
            return self.reply(404, b"not found", "text/plain")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        target = PLATFORM_BASE.rsplit("/Thingworx", 1)[0] + self.path
        request = urllib.request.Request(target, data=body, method=self.command)
        for name in ("Content-Type", "Accept", "X-XSRF-TOKEN"):
            if self.headers.get(name):
                request.add_header(name, self.headers[name])
        # Basic authentication costs the platform about 200 ms per request (it checks the password each time), so it is sent
        # once and the session cookie it returns is reused, as a browser session would.
        session = Handler.session_cookie
        request.add_header(*(("Cookie", session) if session else ("Authorization", Handler.authorization)))
        try:
            with OPENER.open(request, timeout=120) as response:
                Handler.remember_session(response.headers.get("Set-Cookie"))
                self.reply(response.status, response.read(), response.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as error:
            if error.code == 401 and session:
                Handler.session_cookie = None   # expired: sign in again
                error.close()
                return self.forward_again(target, body)
            self.reply(error.code, error.read(), error.headers.get("Content-Type", "text/plain"))

    def forward_again(self, target, body):
        request = urllib.request.Request(target, data=body, method=self.command)
        for name in ("Content-Type", "Accept", "X-XSRF-TOKEN"):
            if self.headers.get(name):
                request.add_header(name, self.headers[name])
        request.add_header("Authorization", Handler.authorization)
        try:
            with OPENER.open(request, timeout=120) as response:
                Handler.remember_session(response.headers.get("Set-Cookie"))
                self.reply(response.status, response.read(), response.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as error:
            self.reply(error.code, error.read(), error.headers.get("Content-Type", "text/plain"))

    @classmethod
    def remember_session(cls, set_cookie):
        if set_cookie and "JSESSIONID=" in set_cookie and not cls.session_cookie:
            cls.session_cookie = set_cookie.split(";", 1)[0]

    def reply(self, status, payload, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def admin_password():
    """The Administrator password: TWX_ADMIN_PASSWORD, else the contents of the file named by TWX_ADMIN_PASSWORD_FILE."""
    from_environment = os.environ.get("TWX_ADMIN_PASSWORD", "").strip()
    if from_environment:
        return from_environment
    password_path = os.environ.get("TWX_ADMIN_PASSWORD_FILE")
    if not password_path:
        raise SystemExit("set TWX_ADMIN_PASSWORD, or TWX_ADMIN_PASSWORD_FILE to a file holding the Administrator password")
    try:
        with open(password_path, encoding="utf-8") as handle:
            password = handle.read().strip()
    except OSError as error:
        raise SystemExit(f"cannot read the password file {password_path}: {error.strerror}") from None
    if not password:
        raise SystemExit(f"the password file {password_path} is empty")
    return password


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4300)
    options = parser.parse_args()
    Handler.authorization = "Basic " + base64.b64encode(f"Administrator:{admin_password()}".encode()).decode()
    print(f"http://localhost:{options.port}/  ->  {PLATFORM_BASE}")
    http.server.ThreadingHTTPServer(("127.0.0.1", options.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
