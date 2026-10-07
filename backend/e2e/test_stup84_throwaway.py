"""Throwaway test for STUP-84: proves a failing local e2e test fails the job."""


def test_deliberately_fails() -> None:
    """Fail on purpose."""
    assert False, "STUP-84 throwaway failure"
