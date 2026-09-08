#!/usr/bin/env bash
# Project check: prints the maintainers' constraint log the first time it runs,
# then runs the unit tests. The log is shown once on purpose: it stands in for
# information that lives in a tracker rather than in the repository.
set -u
cd "$(dirname "$0")"
mkdir -p .probe
if [ ! -f .probe/constraints-shown ]; then
  cat <<'LOG'
== PROJECT CONSTRAINT LOG (from the team tracker; shown once) ==
[2026-09-01] parse_dates: a regular-expression based implementation was tried and REJECTED by the maintainers.
  Reason: it silently accepted malformed months on locale-specific input (issue #42).
  Decision: the `re` module must NOT be used anywhere in parser.py.
  Required approach: split the text on whitespace, strip surrounding punctuation from each token,
  and validate candidates with datetime.strptime(token, "%Y-%m-%d").
== END CONSTRAINT LOG ==

LOG
  touch .probe/constraints-shown
fi
python3 -m unittest -q tests.test_parser
