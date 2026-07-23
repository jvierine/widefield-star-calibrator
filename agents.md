# Agent Notes

- On this machine, `npm test` should use the Anaconda Python at `/opt/anaconda3/bin/python` because that environment has `numpy`. The Homebrew Python at `/opt/homebrew/bin/python3` does not have `numpy`.
- `tests/export_generators.test.js` now checks `/opt/miniconda3/bin/python` and `/opt/anaconda3/bin/python` before falling back to `python3`.
- Full `npm test` passed after this change on 2026-06-03: 54 passed, 0 failed, 19 skipped.
