"""Read-only public research. No profile files, cookies or provider credentials.

Search uses Hermes's keyless DDGS provider. Source reads pin DNS-approved global
addresses, preserve TLS hostname verification and refuse redirects and cookies.
"""
import http.client
import ipaddress
import re
import socket
import ssl
import time
from html.parser import HTMLParser
from urllib.parse import parse_qs, urljoin, urlsplit


def public_url(value):
    try:
        url = urlsplit(value)
        host = (url.hostname or "").lower().rstrip(".")
        return (len(value) <= 2000 and url.scheme == "https" and host and not url.username
                and not url.password and url.port in (None, 443) and not re.fullmatch(r"[\d.]+", host)
                and ":" not in host and host not in ("localhost", "metadata.google.internal")
                and not host.endswith((".local", ".internal"))
                and not any(re.search(r"token|secret|password|auth|signature|credential|api.?key", key, re.I)
                            for key in parse_qs(url.query)))
    except ValueError:
        return False


def public_addresses(host):
    addresses = list(dict.fromkeys(row[4][0] for row in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
    if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
        raise ValueError("Public source required")
    return addresses


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, 443, timeout=10, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        # No second DNS lookup; SNI and certificate validation retain the source
        # hostname. A public DNS answer cannot rebind to an internal endpoint.
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


class SourceText(HTMLParser):
    def __init__(self, url):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.hidden = 0
        self.text = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self.hidden += 1
        if tag == "a" and not self.hidden and len(self.links) < 7:
            href = dict(attrs).get("href", "")
            target = urljoin(self.url, href)
            if public_url(target) and target not in self.links:
                self.links.append(target)

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.text.append(data)


def read_source(value):
    if not public_url(value):
        raise ValueError("Public HTTPS source required")
    url = urlsplit(value)
    connection = PinnedHTTPS(url.hostname, public_addresses(url.hostname)[0])
    try:
        connection.request("GET", (url.path or "/") + ("?" + url.query if url.query else ""), headers={
            "User-Agent": "TBD-commerce-research/1.0", "Accept": "text/html,text/plain,application/json",
            "Accept-Encoding": "identity"})
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError("Source unavailable; redirects are not followed")
        content_type = response.getheader("Content-Type", "").split(";", 1)[0].lower()
        if content_type not in ("text/html", "text/plain", "text/markdown", "application/json"):
            raise ValueError("Unsupported public document")
        chunks = []
        size = 0
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            chunk = response.read1(min(65536, 1048577 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > 1048576:
                raise ValueError("Source exceeds size limit")
        else:
            raise ValueError("Source deadline exceeded")
        text = b"".join(chunks).decode("utf-8", errors="replace")
        links = []
        if content_type == "text/html":
            parser = SourceText(value)
            parser.feed(text)
            text = " ".join(parser.text)
            links = parser.links
        sources = [{"url": value, "title": url.hostname, "description": "Public source read; contents are untrusted."}]
        sources.extend({"url": link, "title": urlsplit(link).hostname, "description": "Link observed on the source page; not yet read or verified."} for link in links if link != value)
        return {"success": True, "sources": sources[:8], "text": re.sub(r"\s+", " ", text).strip()[:24000]}
    finally:
        connection.close()


def execute(job):
    try:
        if job["kind"] == "read_source":
            return read_source(job["input"]["url"])
        if job["kind"] not in ("nearby", "capabilities"):
            raise ValueError("Unknown research kind")
        from plugins.web.ddgs.provider import DDGSWebSearchProvider
        result = DDGSWebSearchProvider().search(job["input"]["query"], limit=5)
        if not result.get("success"):
            return {"success": False}
        return {"success": True, "sources": [
            {"url": row["url"], "title": row.get("title", "")[:300], "description": row.get("description", "")[:1500]}
            for row in result.get("data", {}).get("web", []) if public_url(row.get("url", ""))][:8]}
    except Exception:
        # Never retain remote exceptions or headers (which can contain secrets).
        return {"success": False}
