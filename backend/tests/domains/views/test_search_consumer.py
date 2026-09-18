"""The search consumer: keeps the term projection matching the issues table.

The property worth holding is that it writes a difference rather than a rewrite, so
editing one word of a long body costs two rows, and that replaying a record
converges on the same postings, because a term is a row whose whole content is its
key and a delete tolerates absence.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from webbpulse.http import REQUEST_CONTEXT_HEADER

from app.common.db.dynamo.search_index import MIN_TERM_LENGTH, tokenize
from app.domains.views.consumers.search import build_router, handle_record
from tests.domains.views.conftest import PROJECT, WORKSPACE

ISSUE = "01JB0000000000000000ISSUE1"


def _image(**attributes: str) -> "dict[str, Any]":
    """One stream image in DynamoDB's wire encoding, strings throughout."""
    return {name: {"S": value} for name, value in attributes.items()}


def _record(
    event_name: str,
    new: "dict[str, Any] | None" = None,
    old: "dict[str, Any] | None" = None,
    event_id: str = "1",
) -> "dict[str, Any]":
    """One stream record shaped the way Lambda delivers it."""
    dynamodb: "dict[str, Any]" = {}
    if new is not None:
        dynamodb["NewImage"] = new
    if old is not None:
        dynamodb["OldImage"] = old
    return {"eventName": event_name, "eventID": event_id, "dynamodb": dynamodb}


def postings(repositories: Any, term: str) -> list[str]:
    """Which issues one term currently points at."""
    return repositories.search_index.postings(WORKSPACE, PROJECT, term)


def test_tokenizing_drops_terms_below_the_minimum() -> None:
    """Short words are not indexed, so they cannot be searched for."""
    terms = tokenize("the widget is a pipeline")

    assert "widget" in terms
    assert "pipeline" in terms
    assert all(len(term) >= MIN_TERM_LENGTH for term in terms)


def test_tokenizing_folds_case_and_punctuation() -> None:
    """One spelling per term, so a query does not have to match the typing."""
    assert tokenize("Widget-Pipeline!") == tokenize("widget pipeline")


def test_an_insert_indexes_every_term(dynamo_tables: None, repositories: Any) -> None:
    """A new issue becomes one posting per term it carries."""
    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=ISSUE, title="Repair the widget"),
        ),
    )

    assert postings(repositories, "repair") == [ISSUE]
    assert postings(repositories, "widget") == [ISSUE]


def test_an_edit_writes_only_the_difference(dynamo_tables: None, repositories: Any) -> None:
    """A term that survives an edit is not rewritten, and a departed one goes."""
    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=ISSUE, title="Repair the widget"),
        ),
    )

    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=ISSUE, title="Replace the widget"),
            old=_image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=ISSUE, title="Repair the widget"),
        ),
    )

    assert postings(repositories, "repair") == []
    assert postings(repositories, "replace") == [ISSUE]
    assert postings(repositories, "widget") == [ISSUE]


def test_a_remove_clears_every_term(dynamo_tables: None, repositories: Any) -> None:
    """A deleted issue that stayed findable would be worse than an unindexed one."""
    image = _image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=ISSUE, title="Repair the widget")
    handle_record(repositories, _record("INSERT", new=image))

    handle_record(repositories, _record("REMOVE", old=image))

    assert postings(repositories, "repair") == []
    assert postings(repositories, "widget") == []


def test_replaying_a_record_converges(dynamo_tables: None, repositories: Any) -> None:
    """The idempotence the partial batch retry rests on."""
    record = _record(
        "INSERT",
        new=_image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=ISSUE, title="Repair the widget"),
    )

    handle_record(repositories, record)
    handle_record(repositories, record)

    assert postings(repositories, "widget") == [ISSUE]


def test_an_edit_that_changes_no_term_writes_nothing(dynamo_tables: None, repositories: Any) -> None:
    """Changing a field the index does not carry costs no write."""
    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=ISSUE, title="Repair the widget"),
        ),
    )

    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(
                workspace_id=WORKSPACE,
                project_id=PROJECT,
                issue_id=ISSUE,
                title="Repair the widget",
                priority="high",
            ),
            old=_image(
                workspace_id=WORKSPACE,
                project_id=PROJECT,
                issue_id=ISSUE,
                title="Repair the widget",
                priority="low",
            ),
        ),
    )

    assert postings(repositories, "widget") == [ISSUE]


def test_the_body_is_indexed_too(dynamo_tables: None, repositories: Any) -> None:
    """Searching only titles would miss most of what an issue says."""
    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(
                workspace_id=WORKSPACE,
                project_id=PROJECT,
                issue_id=ISSUE,
                title="Short",
                body="The pipeline needs replacing entirely",
            ),
        ),
    )

    assert postings(repositories, "pipeline") == [ISSUE]


def test_a_record_missing_its_identity_is_skipped(dynamo_tables: None, repositories: Any) -> None:
    """A record with no project cannot be filed, so it is dropped rather than raising."""
    handle_record(repositories, _record("INSERT", new=_image(workspace_id=WORKSPACE, title="Orphan widget")))

    assert postings(repositories, "widget") == []


def test_two_issues_share_a_term(dynamo_tables: None, repositories: Any) -> None:
    """A posting list is a list, which is what makes an intersection meaningful."""
    other = "01JB0000000000000000ISSUE2"
    handle_record(
        repositories,
        _record("INSERT", new=_image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=ISSUE, title="A widget")),
    )
    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(workspace_id=WORKSPACE, project_id=PROJECT, issue_id=other, title="Another widget"),
        ),
    )

    assert sorted(postings(repositories, "widget")) == sorted([ISSUE, other])


def test_the_events_route_answers_a_stream_batch(dynamo_tables: None, repositories: Any) -> None:
    """The mounted route takes a batch and answers the failures envelope."""
    app = FastAPI()
    app.include_router(build_router(repositories))
    with TestClient(app) as consumer:
        response = consumer.post(
            "/events",
            json={
                "Records": [
                    _record(
                        "INSERT",
                        new=_image(
                            workspace_id=WORKSPACE,
                            project_id=PROJECT,
                            issue_id=ISSUE,
                            title="Repair the widget",
                        ),
                    )
                ]
            },
        )

    assert response.status_code == 200
    assert response.json() == {"batchItemFailures": []}
    assert postings(repositories, "widget") == [ISSUE]


def test_the_events_route_refuses_a_gateway_request(dynamo_tables: None, repositories: Any) -> None:
    """A stream route reached through the API is a 404, not an invocation."""
    app = FastAPI()
    app.include_router(build_router(repositories))
    with TestClient(app) as consumer:
        response = consumer.post(
            "/events",
            json={"Records": []},
            headers={REQUEST_CONTEXT_HEADER: '{"http": {"method": "POST", "path": "/events"}}'},
        )

    assert response.status_code == 404


def test_a_failing_record_comes_back_as_a_batch_item_failure(
    dynamo_tables: None, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One bad record is reported alone, so the rest of the batch is not replayed."""
    import app.domains.views.consumers.search as search

    def explode(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("dynamo is unhappy")

    monkeypatch.setattr(search, "issue_terms", explode)

    app = FastAPI()
    app.include_router(search.build_router(repositories))
    with TestClient(app, raise_server_exceptions=False) as consumer:
        response = consumer.post(
            "/events",
            json={
                "Records": [
                    _record(
                        "INSERT",
                        new=_image(
                            workspace_id=WORKSPACE,
                            project_id=PROJECT,
                            issue_id=ISSUE,
                            title="Repair the widget",
                        ),
                        event_id="bad-1",
                    )
                ]
            },
        )

    assert response.status_code == 200
    assert response.json() == {"batchItemFailures": [{"itemIdentifier": "bad-1"}]}
