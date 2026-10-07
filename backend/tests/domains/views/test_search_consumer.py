"""The search consumer: keeps the term projection matching the issues table.

The property worth holding is that it writes a difference rather than a rewrite, so
editing one word of a long body costs two rows, and that replaying a record
converges on the same postings, because a term is a row whose whole content is its
key and a delete tolerates absence.
"""

from __future__ import annotations

from typing import Any

import pytest
from boto3.dynamodb.conditions import Key
from fastapi import FastAPI
from fastapi.testclient import TestClient
from webbpulse.http import REQUEST_CONTEXT_HEADER

from app.common.db.dynamo.search_index import (
    MIN_TERM_LENGTH,
    STOPWORDS,
    TERM_CAP,
    issue_terms,
    legacy_terms,
    ranked_terms,
    tokenize,
)
from app.domains.views.consumers.search import build_router, handle_record
from tests.domains.views.conftest import TEAM, WORKSPACE

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
    return repositories.search_index.postings(WORKSPACE, TEAM, term)


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
            new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Repair the widget"),
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
            new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Repair the widget"),
        ),
    )

    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Replace the widget"),
            old=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Repair the widget"),
        ),
    )

    assert postings(repositories, "repair") == []
    assert postings(repositories, "replace") == [ISSUE]
    assert postings(repositories, "widget") == [ISSUE]


def test_a_remove_clears_every_term(dynamo_tables: None, repositories: Any) -> None:
    """A deleted issue that stayed findable would be worse than an unindexed one."""
    image = _image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Repair the widget")
    handle_record(repositories, _record("INSERT", new=image))

    handle_record(repositories, _record("REMOVE", old=image))

    assert postings(repositories, "repair") == []
    assert postings(repositories, "widget") == []


def test_replaying_a_record_converges(dynamo_tables: None, repositories: Any) -> None:
    """The idempotence the partial batch retry rests on."""
    record = _record(
        "INSERT",
        new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Repair the widget"),
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
            new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Repair the widget"),
        ),
    )

    handle_record(
        repositories,
        _record(
            "MODIFY",
            new=_image(
                workspace_id=WORKSPACE,
                team_id=TEAM,
                issue_id=ISSUE,
                title="Repair the widget",
                priority="high",
            ),
            old=_image(
                workspace_id=WORKSPACE,
                team_id=TEAM,
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
                team_id=TEAM,
                issue_id=ISSUE,
                title="Short",
                body="The pipeline needs replacing entirely",
            ),
        ),
    )

    assert postings(repositories, "pipeline") == [ISSUE]


def test_a_record_missing_its_identity_is_skipped(dynamo_tables: None, repositories: Any) -> None:
    """A record with no team cannot be filed, so it is dropped rather than raising."""
    handle_record(repositories, _record("INSERT", new=_image(workspace_id=WORKSPACE, title="Orphan widget")))

    assert postings(repositories, "widget") == []


def test_two_issues_share_a_term(dynamo_tables: None, repositories: Any) -> None:
    """A posting list is a list, which is what makes an intersection meaningful."""
    other = "01JB0000000000000000ISSUE2"
    handle_record(
        repositories,
        _record("INSERT", new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="A widget")),
    )
    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=other, title="Another widget"),
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
                            team_id=TEAM,
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
                            team_id=TEAM,
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


def test_tokenizing_drops_stopwords() -> None:
    """Common words would post against most issues, so they are never terms."""
    terms = tokenize("this widget should work with that pipeline")

    assert terms == {"widget", "work", "pipeline"}
    assert not terms & STOPWORDS


def test_ranked_terms_keep_the_first_distinct_terms_in_order() -> None:
    """The cap keeps what appears first, so an earlier part wins over a later one."""
    assert ranked_terms("alpha bravo alpha", "charlie delta", cap=3) == {"alpha", "bravo", "charlie"}


def test_issue_terms_cap_the_term_set_and_keep_title_terms() -> None:
    """A long body cannot push the title out of the index."""
    body = " ".join(f"word{index:04d}" for index in range(TERM_CAP * 2))
    terms = issue_terms({"title": "Replace widget", "key": "ABCD-12", "body": body})

    assert len(terms) == TERM_CAP
    assert {"replace", "widget", "abcd"} <= terms


def test_legacy_terms_are_the_uncapped_superset() -> None:
    """The cleanup set covers everything an older indexer might have written."""
    image = {"title": "That widget", "body": " ".join(f"word{index:04d}" for index in range(TERM_CAP + 5))}

    assert issue_terms(image) < legacy_terms(image)
    assert "that" in legacy_terms(image)


def test_indexing_never_reads_the_index(
    dynamo_tables: None, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Posting a term is a single put, with no count query before it."""

    def refuse(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("the consumer queried the index")

    monkeypatch.setattr(repositories.search_index._repository, "query", refuse)
    monkeypatch.setattr(repositories.search_index._repository, "iter_query", refuse)

    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Repair the widget"),
        ),
    )
    monkeypatch.undo()

    assert postings(repositories, "widget") == [ISSUE]


def test_a_long_issue_posts_at_most_the_cap(dynamo_tables: None, repositories: Any) -> None:
    """Two hundred distinct terms, title first, however long the body runs."""
    body = " ".join(f"word{index:04d}" for index in range(TERM_CAP * 2))
    handle_record(
        repositories,
        _record(
            "INSERT",
            new=_image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Replace widget", body=body),
        ),
    )

    held = repositories.search_index._repository.query(Key("ws_team").eq(f"{WORKSPACE}#{TEAM}"), limit=1000)
    assert len(held.items) == TERM_CAP
    assert postings(repositories, "widget") == [ISSUE]
    assert postings(repositories, f"word{TERM_CAP * 2 - 1:04d}") == []


def test_a_title_edit_that_pushes_a_body_term_past_the_cap_unposts_it(dynamo_tables: None, repositories: Any) -> None:
    """A term that falls out of the capped set is deleted, so the diff stays exact."""
    body = " ".join(f"word{index:04d}" for index in range(TERM_CAP))
    last = f"word{TERM_CAP - 1:04d}"
    before = _image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Widget", body=body)
    after = _image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Widget pipeline", body=body)
    handle_record(repositories, _record("INSERT", new=before))
    assert postings(repositories, last) == []
    assert postings(repositories, f"word{TERM_CAP - 2:04d}") == [ISSUE]

    handle_record(repositories, _record("MODIFY", new=after, old=before))

    assert postings(repositories, "pipeline") == [ISSUE]
    assert postings(repositories, f"word{TERM_CAP - 2:04d}") == []
    held = repositories.search_index._repository.query(Key("ws_team").eq(f"{WORKSPACE}#{TEAM}"), limit=1000)
    assert len(held.items) == TERM_CAP


def test_an_edit_cleans_up_a_legacy_stopword_posting(dynamo_tables: None, repositories: Any) -> None:
    """A row written before stopwords existed goes once its word leaves the text."""
    old = _image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="That widget")
    new = _image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="The widget")
    repositories.search_index.add(WORKSPACE, TEAM, "that", ISSUE)
    repositories.search_index.add(WORKSPACE, TEAM, "widget", ISSUE)

    handle_record(repositories, _record("MODIFY", new=new, old=old))

    assert postings(repositories, "that") == []
    assert postings(repositories, "widget") == [ISSUE]


def test_a_remove_clears_legacy_postings_past_the_cap(dynamo_tables: None, repositories: Any) -> None:
    """A deleted issue leaves nothing behind, even rows the cap no longer writes."""
    body = " ".join(f"word{index:04d}" for index in range(TERM_CAP + 10))
    image = _image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="With widget", body=body)
    for term in tokenize("with widget", body) | {"with"}:
        repositories.search_index.add(WORKSPACE, TEAM, term, ISSUE)

    handle_record(repositories, _record("REMOVE", old=image))

    held = repositories.search_index._repository.query(Key("ws_team").eq(f"{WORKSPACE}#{TEAM}"), limit=1000)
    assert held.items == []


def test_a_team_change_moves_every_posting_to_the_new_team(dynamo_tables: None, repositories: Any) -> None:
    """Postings are partitioned by team, so a moved issue is found in its new team and not its old one."""
    other_team = "01JB000000000000000000PRJ9"
    before = _image(workspace_id=WORKSPACE, team_id=TEAM, issue_id=ISSUE, title="Repair the widget")
    after = _image(workspace_id=WORKSPACE, team_id=other_team, issue_id=ISSUE, title="Repair the widget")
    handle_record(repositories, _record("INSERT", new=before))

    handle_record(repositories, _record("MODIFY", new=after, old=before))

    assert postings(repositories, "widget") == []
    assert repositories.search_index.postings(WORKSPACE, other_team, "widget") == [ISSUE]
    assert repositories.search_index.postings(WORKSPACE, other_team, "repair") == [ISSUE]
