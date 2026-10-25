"""Reading one inbound intake mail: who it is for, whether to trust it, and what issue it describes.

Pure functions over the raw MIME bytes SES stored, so the whole of parsing is
testable without a bucket or a table. SES writes its own verdicts into the
message as headers. A sender can add look-alike headers of their own, so a
verdict is read as a failure when any copy of it fails, which can only ever make
a sender's own mail less likely to land.
"""

from __future__ import annotations

import hashlib
import html
import re
from dataclasses import dataclass, field
from email import message_from_bytes, policy
from email.message import EmailMessage
from email.utils import getaddresses, parseaddr
from html.parser import HTMLParser
from typing import Iterable, Optional, cast

from app.common.workspace_export import mask_email

TITLE_MAX = 200

UNTITLED = "Untitled email"

REFERENCES_MAX = 50
"""The most In-Reply-To and References ids one mail is checked against."""

_ADDRESS_HEADERS = ("To", "Cc", "Delivered-To", "X-Original-To", "X-Forwarded-To")

_RECEIVED_FOR = re.compile(r"\bfor\s+<?([^\s<>;]+@[^\s<>;]+)>?", re.IGNORECASE)

_MESSAGE_ID = re.compile(r"<([^<>\s]+)>")

_RESULT = re.compile(r"\b(spf|dkim|dmarc)\s*=\s*([a-z]+)", re.IGNORECASE)

_QUOTE_STARTS = (
    re.compile(r"^\s*on\b.{0,300}\bwrote:\s*$", re.IGNORECASE),
    re.compile(r"^\s*-{2,}\s*original message\s*-{2,}\s*$", re.IGNORECASE),
    re.compile(r"^\s*_{10,}\s*$"),
    re.compile(r"^\s*from:\s.+$", re.IGNORECASE),
)

_SIGNATURE = "-- "


@dataclass(frozen=True)
class IntakeFile:
    """One attached file, as the mail carried it."""

    filename: str
    content_type: str
    data: bytes


@dataclass(frozen=True)
class IntakeMail:
    """What one inbound mail says, reduced to what filing an issue needs.

    `message_id` is the mail's own Message-ID, or a digest of the raw bytes when
    it has none, so a redelivery is still recognised. `rejected` names why the
    mail must be dropped, and is empty when it may be filed.
    """

    message_id: str
    references: tuple[str, ...]
    recipients: tuple[str, ...]
    sender_name: str
    sender_address: str
    subject: str
    body: str
    files: tuple[IntakeFile, ...] = field(default_factory=tuple)
    rejected: str = ""


def message_ids(value: Optional[str]) -> list[str]:
    """Every `<id>` in a Message-ID, In-Reply-To or References header, in order."""
    if not value:
        return []
    return [match.strip() for match in _MESSAGE_ID.findall(str(value)) if match.strip()]


def message_key(message_id: str) -> str:
    """The digest a Message-ID is claimed under, so the table never holds the id itself."""
    return hashlib.sha256(message_id.encode("utf-8")).hexdigest()


def rejection(message: EmailMessage) -> str:
    """Why SES's verdicts say this mail must be dropped, or `""` when none fails."""
    for name, reason in (("X-SES-Spam-Verdict", "spam"), ("X-SES-Virus-Verdict", "virus")):
        if any(str(value).strip().upper() == "FAIL" for value in message.get_all(name, [])):
            return reason
    if any(str(value).strip().lower().startswith("fail") for value in message.get_all("Received-SPF", [])):
        return "spf"
    for value in message.get_all("Authentication-Results", []):
        for method, result in _RESULT.findall(str(value)):
            if result.lower() == "fail":
                return method.lower()
    return ""


def recipients(message: EmailMessage) -> tuple[str, ...]:
    """Every address the mail was delivered to, lower cased, from its headers and SES's Received line."""
    found: list[str] = []
    for name in _ADDRESS_HEADERS:
        for _display, address in getaddresses([str(value) for value in message.get_all(name, [])]):
            if address:
                found.append(address.strip().lower())
    for value in message.get_all("Received", []):
        found.extend(match.strip().lower() for match in _RECEIVED_FOR.findall(str(value)))
    return tuple(dict.fromkeys(found))


def intake_tokens(addresses: Iterable[str], domain: str) -> list[tuple[str, str]]:
    """The `(team key, token)` pairs of the addresses under the intake domain, in order."""
    pairs: list[tuple[str, str]] = []
    suffix = f"@{domain.lower()}"
    for address in addresses:
        if not domain or not address.endswith(suffix):
            continue
        local = address[: -len(suffix)]
        key, dash, token = local.rpartition("-")
        if dash and key and token:
            pairs.append((key, token))
    return list(dict.fromkeys(pairs))


def masked_sender(name: str, address: str) -> str:
    """The sender as an issue shows them: their display name and a masked address.

    A display name holding an `@` is often the address itself, so it is dropped
    rather than shown, and only the masked address is kept.
    """
    masked = mask_email(address) if address else ""
    clean = "" if "@" in name else " ".join(name.split())
    if clean and masked:
        return f"{clean} ({masked})"
    return clean or masked or "an unknown sender"


def title_of(subject: str) -> str:
    """The issue title a subject makes: one line, trimmed to the title limit."""
    line = " ".join(subject.split())
    return line[:TITLE_MAX].rstrip() or UNTITLED


def trim_quoted(text: str) -> str:
    """The new part of a reply: everything above the first quoted block or signature, `>` lines dropped."""
    kept: list[str] = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for index, line in enumerate(lines):
        if line == _SIGNATURE or line.rstrip() == "--":
            break
        if line.lstrip().startswith(">"):
            continue
        if any(pattern.match(line) for pattern in _QUOTE_STARTS[:3]):
            break
        if _QUOTE_STARTS[3].match(line) and kept and not kept[-1].strip() and _header_block(lines[index:]):
            break
        kept.append(line)
    return "\n".join(kept).strip()


def _header_block(lines: list[str]) -> bool:
    """Whether the lines start a forwarded or quoted header block, `From:` then `Sent:` or `Date:`."""
    return any(re.match(r"^\s*(sent|date):\s", line, re.IGNORECASE) for line in lines[1:4])


class _Markdown(HTMLParser):
    """A small HTML to Markdown converter for mail bodies, dropping quoted replies as it goes."""

    _SKIP = {"script", "style", "head", "title", "blockquote"}
    _BLOCKS = {"p", "div", "section", "article", "table", "tr", "ul", "ol", "pre", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self) -> None:
        """Start an empty document."""
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._skip = 0
        self._quote_depth = 0
        self._links: list[str] = []
        self._lists: list[list[int]] = []
        self._pre = 0
        self._stack: list[bool] = []

    def _is_quote(self, tag: str, attrs: dict[str, str]) -> bool:
        """Whether an element holds a quoted reply rather than the new message."""
        classes = attrs.get("class", "")
        return tag in self._SKIP or "gmail_quote" in classes or attrs.get("id", "") in {"appendonsend", "divRplyFwdMsg"}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        """Open one element."""
        values = {key: value or "" for key, value in attrs}
        skipping = self._is_quote(tag, values)
        if tag not in {"br", "img", "hr", "meta", "link", "input"}:
            self._stack.append(skipping)
        if skipping:
            self._skip += 1
            return
        if self._skip:
            return
        if tag == "br":
            self.out.append("\n")
        elif tag == "hr":
            self.out.append("\n\n---\n\n")
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
        elif tag in self._BLOCKS:
            self.out.append("\n\n")
            if tag == "pre":
                self._pre += 1
                self.out.append("```\n")
            elif tag in {"ul", "ol"}:
                self._lists.append([1 if tag == "ol" else 0])
        elif tag == "li":
            marker = "- "
            if self._lists and self._lists[-1][0]:
                marker = f"{self._lists[-1][0]}. "
                self._lists[-1][0] += 1
            self.out.append("\n" + "  " * max(len(self._lists) - 1, 0) + marker)
        elif tag in {"strong", "b"}:
            self.out.append("**")
        elif tag in {"em", "i"}:
            self.out.append("*")
        elif tag == "code" and not self._pre:
            self.out.append("`")
        elif tag == "a":
            self._links.append(values.get("href", ""))
            self.out.append("[")

    def handle_endtag(self, tag: str) -> None:
        """Close one element."""
        skipping = self._stack.pop() if self._stack else False
        if skipping:
            self._skip = max(self._skip - 1, 0)
            return
        if self._skip:
            return
        if tag in {"strong", "b"}:
            self.out.append("**")
        elif tag in {"em", "i"}:
            self.out.append("*")
        elif tag == "code" and not self._pre:
            self.out.append("`")
        elif tag == "a":
            href = self._links.pop() if self._links else ""
            self.out.append(f"]({href})" if href.startswith(("http://", "https://", "mailto:")) else "]")
        elif tag == "pre":
            self._pre = max(self._pre - 1, 0)
            self.out.append("\n```\n\n")
        elif tag in {"ul", "ol"}:
            if self._lists:
                self._lists.pop()
            self.out.append("\n\n")
        elif tag in self._BLOCKS:
            self.out.append("\n\n")

    def handle_data(self, data: str) -> None:
        """Keep text outside quoted replies, collapsing whitespace except inside `pre`."""
        if self._skip:
            return
        self.out.append(data if self._pre else re.sub(r"\s+", " ", data))


def html_to_markdown(source: str) -> str:
    """Markdown for an HTML mail body, with quoted replies dropped."""
    parser = _Markdown()
    parser.feed(source)
    parser.close()
    text = html.unescape("".join(parser.out))
    lines = [line.rstrip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def body_text(message: EmailMessage) -> str:
    """The new text of the mail as Markdown: the plain part when there is one, else the HTML converted."""
    part = message.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        content = part.get_content()
    except (LookupError, ValueError):
        return ""
    if not isinstance(content, str):
        return ""
    if part.get_content_type() == "text/html":
        return trim_quoted(html_to_markdown(content))
    return trim_quoted(content)


def attached_files(message: EmailMessage) -> tuple[IntakeFile, ...]:
    """Every attached file the mail carries, inline images with a filename included."""
    files: list[IntakeFile] = []
    for part in message.iter_attachments():
        if not isinstance(part, EmailMessage) or part.is_multipart():
            continue
        try:
            data = part.get_payload(decode=True)
        except (LookupError, ValueError):
            continue
        if not isinstance(data, bytes) or not data:
            continue
        filename = part.get_filename() or ""
        files.append(IntakeFile(filename=filename, content_type=part.get_content_type(), data=data))
    return tuple(files)


def parse_mail(raw: bytes) -> IntakeMail:
    """Read one raw mail into what filing needs, its rejection reason included."""
    message = cast(EmailMessage, message_from_bytes(raw, policy=policy.default))
    own = message_ids(str(message.get("Message-ID", "")))
    message_id = own[0] if own else f"sha256:{hashlib.sha256(raw).hexdigest()}"
    references = [*message_ids(str(message.get("In-Reply-To", ""))), *message_ids(str(message.get("References", "")))]
    name, address = parseaddr(str(message.get("From", "")))
    return IntakeMail(
        message_id=message_id,
        references=tuple(dict.fromkeys(ref for ref in references if ref != message_id))[:REFERENCES_MAX],
        recipients=recipients(message),
        sender_name=name.strip(),
        sender_address=address.strip().lower(),
        subject=str(message.get("Subject", "") or ""),
        body=body_text(message),
        files=attached_files(message),
        rejected=rejection(message),
    )
