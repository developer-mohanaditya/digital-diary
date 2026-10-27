#!/usr/bin/env python3
"""Dev server for the preview panel.

Serves public/ — the same files the Worker serves — on :3000 like `python -m
http.server`, plus an extensionless `.html` fallback so a path without the suffix
works here exactly as it does on hosting. Standard library only.
"""
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _resolve(self):
        url = self.path.split("?", 1)[0].split("#", 1)[0]
        if url.endswith("/"):
            return
        fs = self.translate_path(url)
        if not os.path.isfile(fs) and os.path.isfile(fs + ".html"):
            self.path = url + ".html"

    def do_GET(self):
        self._resolve()
        super().do_GET()

    def do_HEAD(self):
        self._resolve()
        super().do_HEAD()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    with ThreadingHTTPServer(("0.0.0.0", 3000), Handler) as srv:
        print(f"serving {ROOT} on :3000", flush=True)
        srv.serve_forever()
