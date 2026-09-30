# Task 2 implementation report

Status: implementation committed locally; independent review is pending. No push was performed.

Implementation commit: `fd603c2671f1330a73d274a9a6dba8bc7d1ea8f0` (`feat: add exact field comparison rules`). Base: `9255ae87e02a66ad88c82a27b0860f705e9753e3`.

## RED and GREEN evidence

Before implementation, `moon test --target js` exited 1. The compiler reported the new `compare_field` and `normalize_value` identifiers as unbound (15 references), with the dependent test-value type inference error. This established that the Task 2 API did not exist at the starting commit.

After implementation and formatting, `moon test --target js` passed: 44 tests, 44 passed, 0 failed. `git diff --check` passed. The test coverage includes all requested Task 2 cases: decimal equivalence and signed tolerance boundary, leading-zero text, maximum input limits, relative boundary and intermediate precision beyond 64 digits, scientific notation rejection, Gregorian leap-century rules, exact day difference, single value-map lookup, explicit transform order, empty and zero semantics, missing-value policy, invalid identical values, and side-specific transforms. Existing configuration tests reject negative relative tolerance.

Fixed independent development goldens were checked using Python `Decimal` (precision 300): signed decimal differences, canonical-scale equality, exact tolerance-boundary multiplication, decimal addition/multiplication, and the 128-digit intermediate product. Seven assertions passed. Python is only a development cross-check; decimal behavior in the implementation runs through MoonBit `core/bigint` and passed on the JavaScript target.

## Implementation boundary

- `decimal.mbt` parses the stated signed decimal syntax with a 64-total-digit and 18-fractional-digit input limit. It canonicalizes signed zero and trailing fractional zeroes and provides exact addition, subtraction, multiplication, comparison, absolute value, and formatting. Relative-threshold intermediates have no 64-digit/18-scale cap.
- `date.mbt` accepts only valid four-digit-year `YYYY-MM-DD` Gregorian dates and computes an integer day index; it does not infer formats or time zones.
- `rules.mbt` preserves raw, transformed, and canonical values; applies trim, ASCII lowercase, one side-specific map lookup, missing markers, then declared-type parsing in that order. Content status and missing flags are exposed without an identity score, keeping content comparison separate from identity evidence. Explanations include signed left-minus-right differences and the actual decimal/date threshold.
- `pkg.generated.mbti` changed as expected after `moon info`: it exposes the new `normalize_value` and `compare_field` interfaces and their result structs. No unrelated interface changes were generated.

## Checks

- `moon fmt` — passed.
- `moon info` — passed; expected public-interface additions recorded above.
- `moon test --target js` — 44/44 passed.
- Python `Decimal` fixed goldens — 7/7 passed.
- `git diff --check` — passed.

The commit contains only `decimal.mbt`, `date.mbt`, `rules.mbt`, `rules_wbtest.mbt`, `moon.pkg`, and generated `pkg.generated.mbti`. The report is in the ignored SDD handoff directory and is not part of the implementation commit.
