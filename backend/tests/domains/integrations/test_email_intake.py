"""Create by email: the team settings routes, the address store, the MCP tools and the consumer.

The consumer runs against the real tables with a fake S3 client, so filing,
triage, reply and duplicate handling, the hourly ceiling and attachments are all
held end to end. Every address is under example.com, and no test sends mail.
"""

from __future__ import annotations

import json
from email.message import EmailMessage
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditEvent, AuditQuery

from app.common.customer_intake import INTAKE_AUTHOR, file_intake_request, sender_domain
from app.common.db.dynamo.customers import Customer, CustomerRequest
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import default_triage_settings
from app.common.db.dynamo.team_templates import FormFieldBlueprint, IssueTemplate, template_key
from app.domains.integrations.consumers import email_intake as consumer
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import ADMIN, MEMBER, sign_in
from tests.domains.integrations.conftest import TEAM, WORKSPACE
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

DOMAIN = "intake.example.com"

INTAKE_BUCKET = "intake-test"

ATTACHMENTS = "attachments-test"

INTAKE = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/email-intake"

TEMPLATE = "01JB0000000000000000000TPL"

FORM = "01JB0000000000000000000FRM"


class FakeBody:
    """A streamed S3 body."""

    def __init__(self, data: bytes) -> None:
        """Hold the bytes."""
        self._data = data

    def read(self) -> bytes:
        """Answer the bytes."""
        return self._data


class FakeS3:
    """Stands in for the S3 client: objects by bucket and key, and what was deleted."""

    def __init__(self) -> None:
        """Start empty."""
        self.objects: dict[tuple[str, str], bytes] = {}
        self.deleted: list[tuple[str, str]] = []
        self.content_types: dict[tuple[str, str], str] = {}

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        """Answer one stored object."""
        return {"Body": FakeBody(self.objects[(Bucket, Key)])}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> None:
        """Store one object."""
        self.objects[(Bucket, Key)] = Body
        self.content_types[(Bucket, Key)] = ContentType

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        """Delete one object."""
        self.objects.pop((Bucket, Key), None)
        self.deleted.append((Bucket, Key))


@pytest.fixture(autouse=True)
def intake_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """An intake domain and buckets, as a deployment with create by email has."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "EMAIL_INTAKE_DOMAIN", DOMAIN, raising=False)
    monkeypatch.setattr(settings, "EMAIL_INTAKE_BUCKET", INTAKE_BUCKET, raising=False)
    monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", ATTACHMENTS, raising=False)
    yield


def _logged(repositories: Any, action: str) -> list[AuditEvent]:
    """The workspace's audit entries of one kind."""
    return repositories.audit.list_events(WORKSPACE, AuditQuery(action=action)).events


def _token(repositories: Any, template_id: str | None = None) -> str:
    """The live token of an address."""
    row = repositories.github.email_intake.get(WORKSPACE, TEAM, template_id)
    assert row is not None
    return row.token


def _template(repositories: Any, template_id: str, *, form: bool = False) -> None:
    """One team issue template, a form when asked."""
    repositories.team_config.create_template(
        IssueTemplate(
            workspace_id=WORKSPACE,
            config_key=template_key(TEAM, template_id),
            template_id=template_id,
            team_id=TEAM,
            name="Bug report" if not form else "Intake form",
            title="Bug",
            body="Template body.",
            priority="high",
            form_fields=[FormFieldBlueprint(key="steps", label="Steps", type="text", required=True)] if form else [],
        )
    )


def _issues(repositories: Any) -> list[Issue]:
    """Every issue of the team."""
    page = repositories.issues.list_for_team(WORKSPACE, TEAM)
    return [Issue.model_validate(dict(item)) for item in page.items]


def _enable(repositories: Any, template_id: str | None = None) -> str:
    """Turn an address on as the admin through the service, answering its token."""
    from app.common.recurring_issues import creator_context
    from app.domains.integrations.email_intake import enable_intake

    context = creator_context(repositories, WORKSPACE, ADMIN)
    assert context is not None
    team = repositories.teams.get(WORKSPACE, TEAM)
    enable_intake(repositories, context, team, template_id)
    return _token(repositories, template_id)


def _mail(
    to: str,
    *,
    subject: str = "The printer is on fire",
    body: str = "It is smoking.\n\nOn Mon, 1 Jan 2026, Bob wrote:\n> old words\n",
    message_id: str = "<m1@mail.example.com>",
    headers: dict[str, str] | None = None,
    files: tuple[tuple[str, str, bytes], ...] = (),
    sender: str = "Alice Example <alice@example.com>",
) -> bytes:
    """One raw mail from an example.com sender, unless another is named, to `to`."""
    message = EmailMessage()
    message["From"] = sender
    message["To"] = to
    message["Subject"] = subject
    message["Message-ID"] = message_id
    for name, value in (headers or {}).items():
        message[name] = value
    message.set_content(body)
    for filename, content_type, data in files:
        maintype, subtype = content_type.split("/")
        message.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)
    return message.as_bytes()


def _address(token: str) -> str:
    """The team's address for a token."""
    return f"abc-{token}@{DOMAIN}"


def test_an_admin_turns_the_team_address_on_regenerates_it_and_turns_it_off(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Each step answers the address, revokes the old token, and leaves an audit entry without it."""
    sign_in(client, ADMIN)

    enabled = client.put(INTAKE, json={})
    assert enabled.status_code == 200, enabled.text
    first = _token(repositories)
    assert enabled.json()["address"] == _address(first)
    assert client.put(INTAKE, json={}).json()["address"] == _address(first)

    regenerated = client.post(f"{INTAKE}/regenerate", json={})
    assert regenerated.status_code == 200, regenerated.text
    second = _token(repositories)
    assert second != first
    assert repositories.github.email_intake.resolve(first) is None
    assert repositories.github.email_intake.resolve(second) is not None

    listed = client.get(INTAKE).json()
    assert listed["available"] is True
    assert [row["address"] for row in listed["addresses"]] == [_address(second)]

    assert client.delete(INTAKE).status_code == 204
    assert repositories.github.email_intake.resolve(second) is None
    assert client.delete(INTAKE).status_code == 404
    assert client.get(INTAKE).json()["addresses"] == []

    events = [
        *_logged(repositories, "email_intake.enabled"),
        *_logged(repositories, "email_intake.regenerated"),
        *_logged(repositories, "email_intake.disabled"),
    ]
    assert len(events) == 3
    assert all(event.actor.id == ADMIN and event.target.id == TEAM for event in events)
    dumped = json.dumps([dict(event.after or {}) for event in events])
    assert first not in dumped and second not in dumped


def test_a_template_has_its_own_address_and_a_form_cannot(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """An issue template takes an address, a form template is refused, an unknown one is a 404."""
    _template(repositories, TEMPLATE)
    _template(repositories, FORM, form=True)
    sign_in(client, ADMIN)

    assert client.put(INTAKE, json={"template_id": TEMPLATE}).status_code == 200
    assert client.put(INTAKE, json={"template_id": FORM}).status_code == 422
    assert client.put(INTAKE, json={"template_id": "01JB0000000000000000000UNK"}).status_code == 404
    assert client.put(INTAKE, json={}).status_code == 200

    rows = client.get(INTAKE).json()["addresses"]
    assert [row["template_id"] for row in rows] == [None, TEMPLATE]
    assert rows[0]["address"] != rows[1]["address"]
    assert client.delete(INTAKE, params={"template_id": TEMPLATE}).status_code == 204
    assert [row["template_id"] for row in client.get(INTAKE).json()["addresses"]] == [None]


def test_a_member_reads_but_cannot_change(client: TestClient, workspace: str, repositories: Any) -> None:
    """Changing an address needs team admin."""
    sign_in(client, MEMBER)

    assert client.get(INTAKE).status_code == 200
    assert client.put(INTAKE, json={}).status_code == 403
    assert repositories.github.email_intake.get(WORKSPACE, TEAM) is None


def test_a_deployment_without_a_domain_refuses_to_turn_one_on(
    client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No domain is a 409, and the list says it is unavailable."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "EMAIL_INTAKE_DOMAIN", "", raising=False)
    sign_in(client, ADMIN)

    assert client.put(INTAKE, json={}).status_code == 409
    assert client.get(INTAKE).json()["available"] is False


def test_a_purged_team_loses_its_addresses(workspace: str, repositories: Any) -> None:
    """Deleting the team's rows revokes every token it held."""
    token = _enable(repositories)

    assert repositories.github.email_intake.delete_team(WORKSPACE, TEAM) == 1
    assert repositories.github.email_intake.resolve(token) is None


def test_the_tools_need_the_team_scopes() -> None:
    """Reading is `teams:read`, changing is `teams:write`."""
    assert TOOLS_BY_NAME["get_team_email_intake"].scopes == ("teams:read",)
    assert TOOLS_BY_NAME["update_team_email_intake"].scopes == ("teams:write",)


def test_an_agent_turns_an_address_on_and_off(client: TestClient, workspace: str, repositories: Any) -> None:
    """The tools answer what the routes do."""
    secret = mint_for(repositories, ADMIN, ("teams:write", "teams:read"))

    on = answer(tool(client, secret, "update_team_email_intake", {"team_id": "ABC", "enabled": True}))
    regenerated = answer(tool(client, secret, "update_team_email_intake", {"team_id": TEAM, "regenerate": True}))
    read = answer(tool(client, secret, "get_team_email_intake", {"team_id": TEAM}))
    off = answer(tool(client, secret, "update_team_email_intake", {"team_id": TEAM, "enabled": False}))

    assert len(on["addresses"]) == 1
    assert regenerated["addresses"][0]["address"] != on["addresses"][0]["address"]
    assert read == regenerated
    assert off["addresses"] == []


def test_an_agent_must_name_a_change(client: TestClient, workspace: str, repositories: Any) -> None:
    """A call with nothing to do is refused, and a member may not change an address."""
    admin = mint_for(repositories, ADMIN, ("teams:write",))
    member = mint_for(repositories, MEMBER, ("teams:write",))

    refusal(tool(client, admin, "update_team_email_intake", {"team_id": TEAM}))
    refusal(tool(client, member, "update_team_email_intake", {"team_id": TEAM, "enabled": True}))

    assert repositories.github.email_intake.get(WORKSPACE, TEAM) is None


def test_a_mail_files_one_issue_as_the_admin_via_email(workspace: str, repositories: Any) -> None:
    """Subject to title, trimmed body with the masked sender, email source and the Message-ID kept."""
    token = _enable(repositories)

    issue = consumer.handle_mail(repositories, _mail(_address(token)), s3=FakeS3())

    assert issue is not None
    assert issue.title == "The printer is on fire"
    assert issue.created_by == ADMIN
    assert issue.in_triage is False
    assert issue.body is not None
    assert "a***@example.com" in issue.body and "alice@example.com" not in issue.body
    assert "It is smoking." in issue.body and "old words" not in issue.body
    rows = [dict(row) for row in repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items]
    [created] = [row for row in rows if row["kind"] == "created"]
    assert created["source"] == "email"
    assert created["to_value"] == "m1@mail.example.com"


def test_a_mail_lands_in_triage_when_the_team_has_it_on(workspace: str, repositories: Any) -> None:
    """Triage on sends the issue to the inbox."""
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True})
    )
    token = _enable(repositories)

    issue = consumer.handle_mail(repositories, _mail(_address(token)), s3=FakeS3())

    assert issue is not None and issue.in_triage is True


def test_a_template_address_files_with_its_template(workspace: str, repositories: Any) -> None:
    """The template's fields apply, and the mail's text is the description."""
    _template(repositories, TEMPLATE)
    token = _enable(repositories, TEMPLATE)

    issue = consumer.handle_mail(repositories, _mail(_address(token)), s3=FakeS3())

    assert issue is not None
    assert issue.priority == "high"
    assert issue.title == "The printer is on fire"
    assert issue.body is not None and "It is smoking." in issue.body


def test_redeliveries_replies_and_strangers_are_dropped(workspace: str, repositories: Any) -> None:
    """The same Message-ID files once, a reply to a filed mail files nothing, and an unknown token nothing."""
    token = _enable(repositories)
    s3 = FakeS3()

    assert consumer.handle_mail(repositories, _mail(_address(token)), s3=s3) is not None
    assert consumer.handle_mail(repositories, _mail(_address(token)), s3=s3) is None
    reply = _mail(
        _address(token),
        subject="Re: The printer is on fire",
        message_id="<m2@mail.example.com>",
        headers={"In-Reply-To": "<m1@mail.example.com>"},
    )
    assert consumer.handle_mail(repositories, reply, s3=s3) is None
    assert (
        consumer.handle_mail(repositories, _mail(_address("nosuchtoken"), message_id="<m3@mail.example.com>")) is None
    )

    assert len(_issues(repositories)) == 1


def test_failing_verdicts_file_nothing(workspace: str, repositories: Any) -> None:
    """Spam and failed authentication are dropped before any address is looked up."""
    token = _enable(repositories)

    spam = _mail(_address(token), headers={"X-SES-Spam-Verdict": "FAIL"})
    spoofed = _mail(_address(token), message_id="<m4@mail.example.com>", headers={"Received-SPF": "fail"})

    assert consumer.handle_mail(repositories, spam, s3=FakeS3()) is None
    assert consumer.handle_mail(repositories, spoofed, s3=FakeS3()) is None
    assert _issues(repositories) == []


def test_an_address_past_its_hourly_ceiling_is_dropped(
    workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ceiling is per address."""
    from webbpulse.dynamodb import table_name
    from webbpulse.ratelimit import RATE_LIMIT_TABLE

    from app.common.db.dynamo.client import get_client
    from app.common.db.dynamo.tables import RATE_LIMITS

    get_client().create_table(**RATE_LIMITS.create_table_request(table_name(RATE_LIMIT_TABLE)))
    monkeypatch.setattr(consumer, "HOURLY_CEILING", 1)
    token = _enable(repositories)

    assert consumer.handle_mail(repositories, _mail(_address(token)), s3=FakeS3()) is not None
    second = _mail(_address(token), message_id="<m5@mail.example.com>")
    assert consumer.handle_mail(repositories, second, s3=FakeS3()) is None


def test_a_departed_admin_files_nothing(workspace: str, repositories: Any) -> None:
    """Mail is filed as whoever turned the address on, so it stops when they leave."""
    token = _enable(repositories)
    repositories.memberships.delete(WORKSPACE, ADMIN)

    assert consumer.handle_mail(repositories, _mail(_address(token)), s3=FakeS3()) is None
    assert _issues(repositories) == []


def test_allowed_attachments_are_stored_and_the_rest_skipped(workspace: str, repositories: Any) -> None:
    """A PNG is kept on the issue, an executable is not."""
    token = _enable(repositories)
    s3 = FakeS3()
    raw = _mail(
        _address(token),
        files=(("screen shot.png", "image/png", b"\x89PNG data"), ("run.exe", "application/x-msdownload", b"MZ")),
    )

    issue = consumer.handle_mail(repositories, raw, s3=s3)

    assert issue is not None
    stored = repositories.attachments.iter_for_issue(WORKSPACE, issue.issue_id)
    assert [row.title for row in stored] == ["screen_shot.png"]
    assert list(s3.content_types.values()) == ["image/png"]
    assert all(bucket == ATTACHMENTS for bucket, _key in s3.objects)


def test_a_record_files_its_object_and_deletes_it(workspace: str, repositories: Any) -> None:
    """The S3 event names the object; it is read, filed and removed, and other buckets are ignored."""
    token = _enable(repositories)
    s3 = FakeS3()
    s3.objects[(INTAKE_BUCKET, "inbound/abc 1")] = _mail(_address(token))
    event = {
        "Records": [
            {"s3": {"bucket": {"name": INTAKE_BUCKET}, "object": {"key": "inbound/abc+1"}}},
            {"s3": {"bucket": {"name": "elsewhere"}, "object": {"key": "inbound/x"}}},
        ]
    }

    consumer.handle_record(repositories, {"body": json.dumps(event)}, s3=s3)

    assert s3.deleted == [(INTAKE_BUCKET, "inbound/abc 1")]
    assert len(_issues(repositories)) == 1


def test_safe_filenames_keep_the_extension() -> None:
    """Unsafe characters become underscores and an empty name is numbered."""
    assert consumer.safe_filename("my file (1).pdf", 1) == "my_file_1_.pdf"
    assert consumer.safe_filename("../", 2) == "attachment-2"


def _customer(repositories: Any, name: str, domains: list[str]) -> Customer:
    """One customer of the workspace claiming `domains`."""
    return repositories.customers.create(Customer(workspace_id=WORKSPACE, name=name, domains=domains, created_by=ADMIN))


def _requests(repositories: Any, issue: Issue) -> list[CustomerRequest]:
    """Every customer request naming one issue."""
    return repositories.customers.list_for_target(WORKSPACE, "issue", issue.issue_id)


def test_a_customer_domain_ties_the_issue_to_that_customer(workspace: str, repositories: Any) -> None:
    """The sender's domain, in any case, names one customer, quoted by the subject and authored by the intake."""
    acme = _customer(repositories, "Acme", ["example.com"])
    _customer(repositories, "Other", ["other.example"])
    token = _enable(repositories)

    mail = _mail(_address(token), sender="Alice <Alice@EXAMPLE.com>", subject="  The printer   is on fire ")
    issue = consumer.handle_mail(repositories, mail, s3=FakeS3())

    assert issue is not None
    [request] = _requests(repositories, issue)
    assert request.customer_id == acme.customer_id
    assert request.body == "The printer is on fire"
    assert request.author_id == INTAKE_AUTHOR
    assert request.source == "email"
    assert request.team_ids == [TEAM]
    assert "alice" not in request.model_dump_json().casefold()
    assert len(repositories.customers.list_for_customer(WORKSPACE, acme.customer_id)) == 1


def test_no_match_a_public_provider_or_two_claimants_files_no_request(workspace: str, repositories: Any) -> None:
    """Each still files the issue and ties it to no customer."""
    _customer(repositories, "Mail", ["gmail.com"])
    _customer(repositories, "Twin one", ["twins.example"])
    _customer(repositories, "Twin two", ["twins.example"])
    _customer(repositories, "Parent", ["example.com"])
    token = _enable(repositories)
    senders = ("bob@gmail.com", "carol@twins.example", "dave@sub.example.com", "erin@nowhere.example")

    for index, sender in enumerate(senders):
        mail = _mail(_address(token), sender=sender, message_id=f"<n{index}@mail.example.com>")
        issue = consumer.handle_mail(repositories, mail, s3=FakeS3())
        assert issue is not None
        assert _requests(repositories, issue) == []

    assert repositories.customers.list_requests(WORKSPACE) == []


def test_a_redelivery_or_a_second_filing_adds_no_second_request(workspace: str, repositories: Any) -> None:
    """One request per issue and customer, however often the mail or the filing repeats."""
    _customer(repositories, "Acme", ["example.com"])
    token = _enable(repositories)
    s3 = FakeS3()

    issue = consumer.handle_mail(repositories, _mail(_address(token)), s3=s3)
    assert consumer.handle_mail(repositories, _mail(_address(token)), s3=s3) is None
    assert issue is not None
    assert file_intake_request(repositories, issue, "alice@example.com", "Again") is None

    assert len(_requests(repositories, issue)) == 1
    assert len(repositories.customers.list_requests(WORKSPACE)) == 1


def test_a_failing_customer_lookup_still_files_the_issue(
    workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A customer request that cannot be filed is logged and the issue stands."""
    _customer(repositories, "Acme", ["example.com"])
    token = _enable(repositories)

    def broken(*_args: Any, **_kwargs: Any) -> list[Customer]:
        raise RuntimeError("table unavailable")

    monkeypatch.setattr(repositories.customers, "list_customers", broken)

    issue = consumer.handle_mail(repositories, _mail(_address(token)), s3=FakeS3())

    assert issue is not None
    assert len(_issues(repositories)) == 1


def test_sender_domains_are_lower_cased_and_need_an_at() -> None:
    """The domain after the last `@`, folded, or none without one."""
    assert sender_domain("Alice@Example.COM") == "example.com"
    assert sender_domain("a@b@acme.example.") == "acme.example"
    assert sender_domain("nobody") is None
    assert sender_domain("trailing@") is None
