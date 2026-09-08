"""Date extraction utilities for the notes importer."""


def parse_dates(text: str) -> list[str]:
    """Return every valid ISO date (YYYY-MM-DD) that appears in ``text``.

    Dates are returned in order of appearance. Tokens that look like dates but
    are not real calendar dates (for example 2026-13-40) must be ignored.
    Surrounding punctuation such as commas, periods, and parentheses must not
    prevent a date from being recognised.
    """
    raise NotImplementedError("parse_dates is not implemented yet")
