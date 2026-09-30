# Independent Task 2 review

Verdict: **FAIL** (one required correctness fix).

Reviewed commit: `fd603c2671f1330a73d274a9a6dba8bc7d1ea8f0`, compared with requested base `1204b2f`. Scope: Task 2 only, against `docs/spec.md`, Task 2 in the implementation plan, Task 2 brief and report. No tracked files edited; no push performed.

## Required finding

### [P1] Reject malformed Unicode dates without panicking

Location: `date.mbt:48–52` (especially line 52).

`String.length()` measures UTF-16 code units while `String.to_array()` yields Unicode codepoints. Checking that the former equals 10 does not establish that `chars[7]` exists. For example, `normalize_value("😀😀😀😀-x", date_field_for_test(), "left")` has ten code units but six codepoints. `chars[4]` is `'-'`, so evaluation proceeds to the out-of-bounds `chars[7]` and panics on the supported JavaScript target. A field containing invalid date text must produce `invalid_value`, not abort the comparison.

Fix by validating `chars.length() == 10` before any array indexing (or validate/index consistently using code units and reject non-ASCII input). Add a regression that calls both normalization and comparison with this malformed string and expects ordinary invalid-value results.

Independent reproduction in an archive of the reviewed commit:

```moonbit
///|
test "review unicode malformed date rejects without panic" {
  assert_true(normalize_value("😀😀😀😀-x", date_field_for_test(), "left").invalid)
}
```

`moon test --target js` exits 2 with `Array::at` / `date_parse` at `date.mbt:52:25`. Original tests remain green.

## Verification and assessment

- Repository `HEAD` verified as the reviewed SHA; original `moon test --target js`: **44/44 passed**.
- `git diff --check`: passed; tracked working tree clean.
- Independent temporary archive: `/private/tmp/moonreconcile-review.su3MFZ`.
- Added only in that archive: failing Unicode regression and a deterministic independent golden test generated with Python Decimal (precision 300) and datetime, seed 930. The latter checks 100 signed decimal differences, exact max(abs_tol, rel_tol * magnitude) thresholds/statuses, and 100 Gregorian day differences across years 1–9999. Golden test passed. Combined result: **46 tests, 45 passed, 1 failed** (Unicode regression).
- Exact decimal implementation uses MoonBit BigInt throughout; alignment, sign, zero, formatting and multiplication retain precision. Input limits are enforced; intermediate multiplication is uncapped. No binary floating point used for these calculations.
- Normalization follows trim → ASCII lowercase → one side-specific map lookup → missing recognition → declared-type parsing. Raw/transformed/canonical evidence is retained. Missing/invalid states are kept separate, and no positive identity score is emitted at this milestone; candidate identity policy remains Task 4 work.
- Valid date arithmetic and leap-century semantics passed supplied and independent cases. The Unicode precondition above is the blocking defect.
- API signatures match the Task 2 contract. Comparisons use the validated FieldConfig pipeline; handling arbitrary invalid manually constructed public configs or invalid side strings would be optional API hardening, not established as a Task 2 blocker.
- Inspected other Task 2 Unicode/indexing assumptions: decimal parser and ASCII transforms index arrays using array lengths; decimal formatting indexes generated ASCII digits only. No additional Unicode panic found there.
- Explanations retain signed differences and actual thresholds, and valid identical raw strings do not bypass side-specific canonical comparisons. The evidence is usable for later reporting.

## Improvements versus spec defects

The Unicode date crash is a spec violation and required fix. Optional hardening: make validated-config/side preconditions explicit in public API documentation. No additional required findings identified. This is not acceptance of Tasks 3–8, CLI integration, identity scoring or the full product.

## Scoped re-review after P1 fix

Verdict: **PASS for Task 2**, superseding the initial FAIL above for the reviewed working-tree fix. This verdict applies to commit `fd603c2671f1330a73d274a9a6dba8bc7d1ea8f0` plus the current uncommitted changes to `date.mbt` and `rules_wbtest.mbt`; it does not claim a new committed SHA or full-product acceptance.

The only tracked diff is the requested fix and regression: `date_parse` constructs its codepoint array first and checks `chars.length() == 10` before any indexed access. This establishes all subsequent index bounds, while the existing ASCII-digit/separator checks reject supplementary characters even when the array itself has ten entries. The regression covers both direct normalization and field comparison, preserving raw/transformed evidence and asserting invalid-value output.

Independent checks:

- Re-ran repository `moon test --target js`: **45/45 passed**.
- Copied only the two modified files into the independent temporary archive; retained the original reproducer and the 100 Decimal/100 datetime golden checks.
- Added a separate archive-only regression with six malformed Unicode strings, exercising left, right, and identical-invalid pairs plus direct normalization on each side. This includes ten-codepoint input with supplementary characters, ensuring a codepoint-count pass does not admit a non-ASCII date.
- Archive `moon test --target js`: **48/48 passed**. The original reproducer now passes. No remaining Task 2 findings identified.

No tracked files edited by reviewer; no commit or push performed. npm integration checks reported by the parent were not independently rerun in this scoped re-review.
