"""Reading an inbound intake mail: verdicts, recipients, the body and the masked sender.

Every address here is under example.com, and the sender is only ever shown masked.
"""

from __future__ import annotations

from email.message import EmailMessage

from app.domains.integrations.intake_mail import (
    UNTITLED,
    html_to_markdown,
    intake_tokens,
    masked_sender,
    message_key,
    parse_mail,
    title_of,
    trim_quoted,
)

ADDRESS = "abc-tok3n@intake.example.com"


def _raw(*, headers: dict[str, str] | None = None, body: str = "Hello.", html: str | None = None) -> bytes:
    """One mail to the intake address from an example.com sender."""
    message = EmailMessage()
    message["From"] = "Alice Example <alice@example.com>"
    message["To"] = ADDRESS
    message["Subject"] = "The printer is on fire"
    message["Message-ID"] = "<m1@mail.example.com>"
    for name, value in (headers or {}).items():
        message[name] = value
    message.set_content(body)
    if html is not None:
        message.add_alternative(html, subtype="html")
    return message.as_bytes()


def test_a_plain_mail_reads_into_what_filing_needs() -> None:
    """Subject, body, recipients, sender and Message-ID come through, nothing rejected."""
    mail = parse_mail(_raw())

    assert mail.subject == "The printer is on fire"
    assert mail.body == "Hello."
    assert ADDRESS in mail.recipients
    assert mail.message_id == "m1@mail.example.com"
    assert mail.sender_address == "alice@example.com"
    assert mail.rejected == ""


def test_the_plain_part_is_preferred_over_the_html_one() -> None:
    """A multipart mail files its plain text, not the HTML converted."""
    mail = parse_mail(_raw(body="Plain words.", html="<p><b>Rich</b> words.</p>"))

    assert mail.body == "Plain words."


def test_failing_verdicts_reject_the_mail() -> None:
    """Spam, virus, SPF and DKIM failures each name their reason."""
    assert parse_mail(_raw(headers={"X-SES-Spam-Verdict": "FAIL"})).rejected == "spam"
    assert parse_mail(_raw(headers={"X-SES-Virus-Verdict": "FAIL"})).rejected == "virus"
    assert parse_mail(_raw(headers={"Received-SPF": "fail (example.com)"})).rejected == "spf"
    assert parse_mail(_raw(headers={"Authentication-Results": "amazonses.com; dkim=fail"})).rejected == "dkim"
    assert parse_mail(_raw(headers={"X-SES-Spam-Verdict": "PASS"})).rejected == ""


def test_a_mail_without_a_message_id_is_keyed_by_its_bytes() -> None:
    """A redelivery of the same bytes is still recognised."""
    message = EmailMessage()
    message["To"] = ADDRESS
    message.set_content("No id.")
    raw = message.as_bytes()

    assert parse_mail(raw).message_id == parse_mail(raw).message_id
    assert parse_mail(raw).message_id.startswith("sha256:")


def test_replies_carry_the_ids_they_answer() -> None:
    """In-Reply-To and References are kept, the mail's own id left out."""
    mail = parse_mail(_raw(headers={"In-Reply-To": "<m0@mail.example.com>", "References": "<m0@mail.example.com>"}))

    assert mail.references == ("m0@mail.example.com",)


def test_quoted_replies_and_signatures_are_trimmed() -> None:
    """Only the new text above the quote survives."""
    text = "New words.\n\nOn Mon, 1 Jan 2026, Bob <bob@example.com> wrote:\n> old words\n"
    assert trim_quoted(text) == "New words."
    assert trim_quoted("Hi.\n-- \nSig") == "Hi."
    assert trim_quoted("Hi.\n> quoted\nMore.") == "Hi.\nMore."


def test_html_converts_to_markdown_and_drops_the_quote() -> None:
    """Bold, links and lists convert, and a Gmail quote block is dropped."""
    source = (
        '<div><p><b>Broken</b> on <a href="https://example.com/x">this page</a></p>'
        "<ul><li>one</li><li>two</li></ul>"
        '<div class="gmail_quote">old thread</div></div>'
    )

    text = html_to_markdown(source)

    assert "**Broken**" in text
    assert "[this page](https://example.com/x)" in text
    assert "- one" in text and "- two" in text
    assert "old thread" not in text


def test_only_intake_domain_addresses_yield_tokens() -> None:
    """The team key and token split at the last dash, other domains ignored."""
    pairs = intake_tokens(
        ["abc-tok3n@intake.example.com", "abc-x@example.com", "bad@intake.example.com"], "intake.example.com"
    )

    assert pairs == [("abc", "tok3n")]
    assert intake_tokens(["abc-tok3n@intake.example.com"], "") == []


def test_the_sender_is_masked() -> None:
    """The display name stays and the address is reduced to its first letter and domain."""
    assert masked_sender("Alice Example", "alice@example.com") == "Alice Example (a***@example.com)"
    assert masked_sender("", "alice@example.com") == "a***@example.com"
    assert masked_sender("alice@example.com", "alice@example.com") == "a***@example.com"
    assert masked_sender("alice@example.com", "") == "an unknown sender"
    assert masked_sender("", "") == "an unknown sender"


def test_titles_are_one_line_and_never_empty() -> None:
    """Whitespace collapses and an empty subject gets a stand-in."""
    assert title_of("  Fix\n the  thing ") == "Fix the thing"
    assert title_of("") == UNTITLED
    assert len(title_of("x" * 500)) == 200


def test_message_keys_never_hold_the_id() -> None:
    """The claim key is a digest."""
    assert "example.com" not in message_key("m1@mail.example.com")
