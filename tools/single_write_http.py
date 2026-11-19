"""An http.client connection that sends a request's headers and a bytes body in one write, as a browser does for a small body.

http.client writes the headers and the body separately. Through Docker Desktop's port forwarding on Windows the second write
waits for the first one's delayed acknowledgement, so every POST to a platform in Docker took 44 ms instead of 1-2 ms (GETs,
with no body, were unaffected). Used by tools/perf/measure.py and tools/dev_server.py.
"""
import http.client, urllib.request


class SingleWriteConnection(http.client.HTTPConnection):
    def _send_output(self, message_body=None, encode_chunked=False):
        if not isinstance(message_body, (bytes, bytearray)):
            return super()._send_output(message_body, encode_chunked)
        self._buffer.extend((b"", b""))
        message = b"\r\n".join(self._buffer) + bytes(message_body)
        del self._buffer[:]
        self.send(message)


class SingleWriteHandler(urllib.request.HTTPHandler):
    """For urllib: `urllib.request.build_opener(SingleWriteHandler)`."""

    def http_open(self, request):
        return self.do_open(SingleWriteConnection, request)
