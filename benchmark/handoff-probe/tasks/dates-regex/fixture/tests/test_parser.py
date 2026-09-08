import unittest

from parser import parse_dates


class ParseDatesTest(unittest.TestCase):
    def test_finds_dates_in_order(self):
        text = "Kickoff on 2026-09-08, review (2026-10-01) and launch 2026-11-15."
        self.assertEqual(parse_dates(text), ["2026-09-08", "2026-10-01", "2026-11-15"])

    def test_ignores_invalid_calendar_dates(self):
        self.assertEqual(parse_dates("bad 2026-13-40 and 2026-02-30 ok 2026-02-28"), ["2026-02-28"])

    def test_ignores_non_dates(self):
        self.assertEqual(parse_dates("ticket 1234-56-78x and version 2026-09"), [])

    def test_empty(self):
        self.assertEqual(parse_dates(""), [])


if __name__ == "__main__":
    unittest.main()
