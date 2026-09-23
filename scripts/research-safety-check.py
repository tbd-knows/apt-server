"""Standard-library checks: no Hermes install or external network required."""
import importlib.util
import pathlib
import socket
import unittest
from unittest.mock import patch

source = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugins/tbd-commerce-a2a/research.py"
spec = importlib.util.spec_from_file_location("research", source)
research = importlib.util.module_from_spec(spec)
spec.loader.exec_module(research)


class ResearchSafety(unittest.TestCase):
    def test_public_urls(self):
        for url in ("http://example.com", "file:///etc/passwd", "https://localhost", "https://127.0.0.1",
                    "https://[::1]", "https://user:secret@example.com", "https://example.com?api_key=secret",
                    "https://example.com:8443", "https://service.internal"):
            self.assertFalse(research.public_url(url), url)
        self.assertTrue(research.public_url("https://www.ups.com/us/en/support/shipping-support"))

    def test_private_dns_and_mixed_answers_rejected(self):
        for ips in (["127.0.0.1"], ["169.254.169.254"], ["93.184.216.34", "10.0.0.1"], ["::1"]):
            answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ips]
            with patch.object(research.socket, "getaddrinfo", return_value=answers):
                with self.assertRaises(ValueError):
                    research.public_addresses("example.com")

    def test_html_is_plain_untrusted_text(self):
        parser = research.SourceText("https://example.com/info")
        parser.feed('<script>hidden private code</script><p>Hours unverified</p><a href="/capabilities">Tools</a><a href="http://localhost">bad</a>')
        self.assertNotIn("hidden private code", " ".join(parser.text))
        self.assertIn("Hours unverified", " ".join(parser.text))
        self.assertEqual(parser.links, ["https://example.com/capabilities"])

    def test_failure_does_not_return_remote_details(self):
        with patch.object(research, "read_source", side_effect=RuntimeError("SECRET_CANARY")):
            self.assertEqual(research.execute({"kind":"read_source", "input":{"url":"https://example.com"}}), {"success":False})


if __name__ == "__main__":
    unittest.main()
