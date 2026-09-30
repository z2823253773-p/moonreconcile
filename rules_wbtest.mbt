///|
fn decimal_field_for_test(
  abs_tol? : String = "0",
  rel_tol? : String = "0",
  left_values? : Map[String, String] = Map([]),
  right_values? : Map[String, String] = Map([]),
) -> FieldConfig {
  {
    name: "amount",
    left: "left_amount",
    right: "right_amount",
    field_type: "decimal",
    compare: true,
    trim_ascii: false,
    lower_ascii: false,
    left_values,
    right_values,
    missing: [],
    both_missing: "equal",
    abs_tol,
    rel_tol,
    days_tol: 0,
  }
}

///|
fn text_field_for_test(
  trim_ascii? : Bool = false,
  lower_ascii? : Bool = false,
  left_values? : Map[String, String] = Map([]),
  right_values? : Map[String, String] = Map([]),
  missing? : Array[String] = [],
  both_missing? : String = "equal",
) -> FieldConfig {
  {
    name: "label",
    left: "left_label",
    right: "right_label",
    field_type: "text",
    compare: true,
    trim_ascii,
    lower_ascii,
    left_values,
    right_values,
    missing,
    both_missing,
    abs_tol: "0",
    rel_tol: "0",
    days_tol: 0,
  }
}

///|
fn date_field_for_test(days_tol? : Int = 0) -> FieldConfig {
  {
    name: "date",
    left: "left_date",
    right: "right_date",
    field_type: "date",
    compare: true,
    trim_ascii: false,
    lower_ascii: false,
    left_values: Map([]),
    right_values: Map([]),
    missing: [],
    both_missing: "equal",
    abs_tol: "0",
    rel_tol: "0",
    days_tol,
  }
}

///|
test "decimal_scale_difference_is_equivalent_by_rule" {
  let result = compare_field("100.00", "100", decimal_field_for_test())
  assert_eq(result.status, "equivalent_by_rule")
  assert_eq(result.difference, Some("0"))
  assert_eq(result.tolerance, Some("0"))
  assert_eq(result.left_raw, "100.00")
  assert_eq(result.right_raw, "100")
  assert_eq(result.left_canonical, Some("100"))
  assert_eq(result.right_canonical, Some("100"))
}

///|
test "text_identifier_keeps_leading_zeroes" {
  let result = compare_field("001", "1", text_field_for_test())
  assert_eq(result.status, "different")
  assert_eq(result.difference, None)
}

///|
test "negative_decimal_difference_uses_inclusive_absolute_tolerance" {
  let result = compare_field(
    "-0.01",
    "0.01",
    decimal_field_for_test(abs_tol="0.02"),
  )
  assert_eq(result.status, "equivalent_by_rule")
  assert_eq(result.difference, Some("-0.02"))
  assert_eq(result.tolerance, Some("0.02"))
}

///|
test "same_raw_decimal_with_different_side_maps_is_not_reported_equal" {
  let field = decimal_field_for_test(
    abs_tol="1",
    left_values=Map([("1", "1")]),
    right_values=Map([("1", "2")]),
  )
  let result = compare_field("1", "1", field)
  assert_eq(result.status, "equivalent_by_rule")
  assert_eq(result.difference, Some("-1"))
}

///|
test "decimal_difference_over_tolerance_is_different" {
  let result = compare_field(
    "-0.01",
    "0.01",
    decimal_field_for_test(abs_tol="0.019"),
  )
  assert_eq(result.status, "different")
  assert_eq(result.difference, Some("-0.02"))
  assert_eq(result.tolerance, Some("0.019"))
}

///|
test "maximum_input_digits_remain_exact" {
  let left = "9".repeat(64)
  let right = "9".repeat(63) + "8"
  let result = compare_field(left, right, decimal_field_for_test())
  assert_eq(result.status, "different")
  assert_eq(result.difference, Some("1"))
  assert_eq(result.left_canonical, Some(left))
}

///|
test "decimal_input_limits_are_enforced_without_rounding" {
  let valid = "-" + "9".repeat(46) + "." + "1".repeat(18)
  let overflow_digits = normalize_value(
    "1".repeat(65),
    decimal_field_for_test(),
    "left",
  )
  let overflow_scale = normalize_value(
    "0." + "1".repeat(19),
    decimal_field_for_test(),
    "left",
  )
  let boundary = normalize_value(valid, decimal_field_for_test(), "left")
  assert_true(overflow_digits.invalid)
  assert_true(overflow_scale.invalid)
  assert_true(!boundary.invalid)
  assert_eq(boundary.canonical, Some(valid))
}

///|
test "relative_product_keeps_precision_beyond_input_limits" {
  let magnitude = "1" + "0".repeat(63)
  let result = compare_field(
    magnitude,
    "0",
    decimal_field_for_test(rel_tol=magnitude),
  )
  assert_eq(result.status, "equivalent_by_rule")
  assert_eq(result.difference, Some(magnitude))
  assert_eq(result.tolerance, Some("1" + "0".repeat(126)))
}

///|
test "decimal_arithmetic_helpers_preserve_sign_and_scale" {
  let a = decimal_parse("12.30").unwrap()
  let b = decimal_parse("-0.3").unwrap()
  assert_eq(decimal_format(decimal_add(a, b)), "12")
  assert_eq(decimal_format(decimal_subtract(a, b)), "12.6")
  assert_eq(decimal_format(decimal_multiply(a, b)), "-3.69")
  assert_eq(decimal_compare(a, b), 1)
}

///|
test "positive_sign_and_negative_zero_normalize_exactly" {
  assert_eq(decimal_format(decimal_parse("+001.2300").unwrap()), "1.23")
  assert_eq(decimal_format(decimal_parse("-0.000").unwrap()), "0")
}

///|
test "relative_tolerance_boundary_uses_exact_product" {
  // The relative product 100 * 0.01 exactly equals the signed difference.
  let result = compare_field(
    "100",
    "99.00",
    decimal_field_for_test(rel_tol="0.01"),
  )
  assert_eq(result.status, "equivalent_by_rule")
  assert_eq(result.difference, Some("1"))
  assert_eq(result.tolerance, Some("1"))
}

///|
test "scientific_notation_is_invalid_even_when_raw_values_match" {
  let result = compare_field("1e3", "1e3", decimal_field_for_test())
  assert_eq(result.status, "invalid_value")
  assert_eq(result.left_raw, "1e3")
  assert_eq(result.right_raw, "1e3")
  assert_true(result.left_canonical is None)
}

///|
test "gregorian_leap_century_validates_2000_and_rejects_1900" {
  let good = normalize_value("2000-02-29", date_field_for_test(), "left")
  let bad = normalize_value("1900-02-29", date_field_for_test(), "left")
  assert_eq(good.canonical, Some("2000-02-29"))
  assert_true(bad.canonical is None)
  assert_true(bad.invalid)
}

///|
test "date_day_boundary_and_signed_difference_are_exact" {
  let result = compare_field(
    "2000-03-01",
    "2000-02-29",
    date_field_for_test(days_tol=1),
  )
  assert_eq(result.status, "equivalent_by_rule")
  assert_eq(result.difference, Some("1"))
  assert_eq(result.tolerance, Some("1"))
}

///|
test "value_mapping_is_a_single_lookup" {
  let left_values = Map([("A", "B"), ("B", "C")])
  let normalized = normalize_value(
    "A",
    text_field_for_test(left_values~),
    "left",
  )
  assert_eq(normalized.raw, "A")
  assert_eq(normalized.transformed, "B")
  assert_eq(normalized.canonical, Some("B"))
}

///|
test "normalization_order_is_trim_lower_map_then_missing" {
  let mapping = Map([("a", "N/A")])
  let field = text_field_for_test(
    trim_ascii=true,
    lower_ascii=true,
    left_values=mapping,
    missing=["N/A"],
  )
  let value = normalize_value(" A ", field, "left")
  assert_eq(value.raw, " A ")
  assert_eq(value.transformed, "N/A")
  assert_true(value.missing)
  assert_eq(value.rules, [
    "trim_ascii", "lower_ascii", "value_map", "missing_marker",
  ])
}

///|
test "empty_text_is_not_missing_by_default" {
  let result = compare_field("", "", text_field_for_test())
  assert_eq(result.status, "equal")
  assert_true(!result.left_missing)
  assert_true(!result.right_missing)
}

///|
test "zero_decimal_is_not_missing" {
  let normalized = normalize_value("0", decimal_field_for_test(), "left")
  assert_true(!normalized.missing)
  assert_eq(normalized.canonical, Some("0"))
}

///|
test "both_missing_issue_requires_review" {
  let field = text_field_for_test(missing=["N/A"], both_missing="issue")
  let result = compare_field("N/A", "N/A", field)
  assert_eq(result.status, "different")
  assert_eq(result.explanation, "both_missing_requires_review")
  assert_true(result.left_missing)
  assert_true(result.right_missing)
}

///|
test "equal_status_requires_same_raw_value_even_for_missing_policy" {
  let field = text_field_for_test(missing=["N/A", "NULL"])
  let same = compare_field("N/A", "N/A", field)
  let equivalent = compare_field("N/A", "NULL", field)
  assert_eq(same.status, "equal")
  assert_eq(equivalent.status, "equivalent_by_rule")
  assert_eq(equivalent.explanation, "both_values_missing_by_policy")
}

///|
test "identical_invalid_values_are_not_equal" {
  let result = compare_field("2024-02-30", "2024-02-30", date_field_for_test())
  assert_eq(result.status, "invalid_value")
}
