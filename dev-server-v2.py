#!/usr/bin/env python3
"""Dev server for the v2 preview panel.

Serves public/demo/v2/ at the root on :3001, so `../logo/mark.svg` still resolves to
the logo that lives in public/demo/logo. Standard library only.
"""
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "public", "demo", "v2")
LOGO = os.path.join(HERE, "public", "demo", "logo")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        url = path.split("?", 1)[0].split("#", 1)[0]
        if url.startswith("/logo/"):
            return os.path.join(LOGO, os.path.basename(url))
        return super().translate_path(path)

    def end_headers(self):
        # A preview must never let the panel keep an old build: the page and its script change
        # on every edit, so every request asks for the file again.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3001"))
    with ThreadingHTTPServer(("0.0.0.0", port), Handler) as srv:
        print(f"serving {ROOT} on :{port}", flush=True)
        srv.serve_forever()
