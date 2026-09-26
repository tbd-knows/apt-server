"""Thin commerce boundary around the pinned Hermes A2A implementation.

The A2A task carries an immutable message UUID, not an owner's private prompt.
The server verifies its sender/recipient and wakes the private owner session.
Only a deterministic receipt is returned to the peer. Replies the owner decides
to share are new approved messages, delivered through the same outbox.
"""
import asyncio
import json
import logging
import os
import re
import urllib.request

from gateway.config import Platform
from plugins.platforms.a2a.adapter import A2AAdapter
from plugins.platforms.a2a import protocol, security, tools as client
from .research import execute as research_execute

LOG = logging.getLogger(__name__)
MESSAGE = re.compile(r"tbd-message:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\Z")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Redirect refused")


def internal(path, body=None):
    url = os.environ["APT_INTERNAL_URL"].rstrip("/") + "/internal/a2a/" + path
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + os.environ["APT_A2A_BRIDGE_TOKEN"], "Content-Type": "application/json"})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        return json.loads(response.read(65536))


def deliver(entry):
    """Use Hermes's client/protocol helpers, pinning the approved peer endpoint.

    Do not follow a card-advertised URL with bearer credentials. The peer URL
    comes from operator configuration through the authenticated server bridge.
    """
    peer = entry["peer"]
    message_id = entry["messageId"]
    headers = {"Authorization": "Bearer " + peer["token"], "A2A-Version": protocol.PROTOCOL_VERSION}
    opener = urllib.request.build_opener(NoRedirect())
    card_request = urllib.request.Request(peer["url"].rstrip("/") + "/.well-known/agent-card.json", headers=headers)
    with opener.open(card_request, timeout=15) as response:
        card = json.loads(response.read(65536))
    if not any(s.get("id") == "tbd-approved-commerce" for s in card.get("skills", [])):
        raise ValueError("Peer does not advertise the approved commerce boundary")
    message = protocol.text_message(protocol.ROLE_USER, "tbd-message:" + message_id, context_id=message_id)
    message["messageId"] = message_id
    request = urllib.request.Request(peer["url"], data=json.dumps({"jsonrpc": "2.0", "id": message_id,
        "method": "SendMessage", "params": {"message": message}}).encode(),
        headers={**headers, "Content-Type": "application/json"})
    with opener.open(request, timeout=20) as response:
        result = json.loads(response.read(65536))
    if result.get("error"):
        raise ValueError("Peer rejected the delivery")
    task = protocol.unwrap_send_message_response(result.get("result", {}))
    receipt = json.loads(client._reply_text_from_result(task))
    if receipt != {"messageId": message_id, "status": "received"}:
        raise ValueError("Peer did not confirm this message")


class CommerceAdapter(A2AAdapter):
    def __init__(self, config):
        super().__init__(config)
        self.platform = Platform("tbd_commerce")
        self._outbox_task = None
        self._research_task = None

    async def connect(self, **kwargs):
        # Never fall back to Hermes's unauthenticated local mode for commerce.
        if not os.getenv("A2A_PEER_TOKENS") or not os.getenv("APT_A2A_BRIDGE_TOKEN"):
            self._set_fatal_error("missing_auth", "TBD A2A credentials are required", retryable=False)
            return False
        connected = await super().connect(**kwargs)
        if connected:
            self._outbox_task = asyncio.create_task(self._deliver_outbox())
            self._research_task = asyncio.create_task(self._research_outbox())
        return connected

    async def disconnect(self):
        for task in (self._outbox_task, self._research_task):
            if not task:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await super().disconnect()

    async def _research_outbox(self):
        while True:
            try:
                batch = await asyncio.to_thread(internal, "research/outbox")
                for job in batch["jobs"]:
                    result = await asyncio.to_thread(research_execute, job)
                    await asyncio.to_thread(internal, "research/complete", {
                        "id": job["id"], "leaseId": job["leaseId"], "result": result})
            except asyncio.CancelledError:
                raise
            except Exception:
                LOG.warning("TBD_RESEARCH_PENDING")
            await asyncio.sleep(5)

    async def _deliver_outbox(self):
        while True:
            try:
                batch = await asyncio.to_thread(internal, "outbox")
                for entry in batch["messages"]:
                    await asyncio.to_thread(deliver, entry)
            except asyncio.CancelledError:
                raise
            except Exception:
                # The server owns the bounded lease/retry history. No private
                # provider response, credential or peer text goes into logs.
                LOG.warning("TBD_A2A_DELIVERY_PENDING")
            await asyncio.sleep(5)

    def _build_card(self, public_url=None, agent=None):
        card = super()._build_card(public_url, agent)
        card["description"] = "Deliver an approved TBD commerce message and receive its receipt. Owner decisions arrive separately."
        card["skills"] = [{"id": "tbd-approved-commerce", "name": "Approved commerce messages",
            "description": "Participant-authorized message delivery", "tags": ["commerce"]}]
        card["capabilities"]["pushNotifications"] = False
        return card

    def _prepare_task(self, params, peer, agent=None):
        text = protocol.extract_text(params)
        match = MESSAGE.fullmatch(text)
        if not match or protocol.extract_context_id(params) != match.group(1):
            task_id = protocol.new_task_id()
            context_id = protocol.new_context_id()
            return protocol.build_task(task_id, context_id, protocol.STATE_REJECTED,
                "Only approved commerce message references are accepted."), None
        return super()._prepare_task(params, peer, agent)

    async def handle_message(self, event):
        # Deliberately never call the gateway model handler. Even a compromised
        # peer cannot invoke private memory, owner tools, or operator commands.
        peer = event.source.user_id
        prefix = security.PRIVACY_PREFIX.format(peer=peer or "unknown")
        text = event.text.removeprefix(prefix)
        match = MESSAGE.fullmatch(text)
        try:
            if not match:
                raise ValueError("Invalid commerce reference")
            receipt = await asyncio.to_thread(internal, "receive", {
                "messageId": match.group(1), "contextId": event.source.chat_id,
                "taskId": event.message_id, "peer": peer})
            if receipt != {"messageId": match.group(1), "status": "received"}:
                raise ValueError("Invalid receipt")
            self._resolve_task(event.message_id, protocol.STATE_COMPLETED, json.dumps(receipt))
        except Exception:
            self._resolve_task(event.message_id, protocol.STATE_REJECTED, "Shared message not found or delivery unavailable.")

    def _register_inline_push(self, task_id, params, agent=None):
        # No caller-controlled callbacks; delivery is polled and persisted.
        return None

    def _rpc_push_config_create(self, req_id, params, agent=None):
        return protocol.jsonrpc_error(req_id, protocol.ERR_PUSH_NOT_SUPPORTED, "Use task retrieval")


def register(ctx):
    ctx.register_platform(name="tbd_commerce", label="TBD commerce A2A",
        adapter_factory=CommerceAdapter, check_fn=lambda: True,
        is_connected=lambda config: True, allow_update_command=False)
