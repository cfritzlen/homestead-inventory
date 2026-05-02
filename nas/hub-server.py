#!/usr/bin/env python3
"""Homestead Hub web server with Frigate API proxy.

Serves static files from /home/moco/homestead/web on port 8080.
Proxies /api/* requests to Frigate on localhost:5000 to avoid CORS issues.
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import os
import sys
import threading

STATIC_DIR = '/home/moco/homestead/web'
FRIGATE_URL = 'http://localhost:5000'
PORT = 8080


class HubHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        if self.path.startswith('/api/'):
            self.proxy_to_frigate()
        else:
            super().do_GET()

    def proxy_to_frigate(self):
        target = FRIGATE_URL + self.path
        try:
            req = urllib.request.Request(target)
            # Forward range headers for streaming
            for header in ('Range', 'Accept'):
                val = self.headers.get(header)
                if val:
                    req.add_header(header, val)

            resp = urllib.request.urlopen(req, timeout=30)
            self.send_response(resp.status)
            # Pass through content headers
            for key in ('Content-Type', 'Content-Length', 'Content-Disposition'):
                val = resp.headers.get(key)
                if val:
                    self.send_header(key, val)
            self.end_headers()

            # Stream the response
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except BrokenPipeError:
                    break
            resp.close()
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            body = e.read()
            if body:
                self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(f'Proxy error: {e}'.encode())

    def log_message(self, format, *args):
        # Quieter logging
        pass


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    os.chdir(STATIC_DIR)
    server = ThreadedServer(('0.0.0.0', PORT), HubHandler)
    print(f'Homestead Hub running on http://0.0.0.0:{PORT} (threaded)')
    print(f'Proxying /api/* -> {FRIGATE_URL}')
    sys.stdout.flush()
    server.serve_forever()
