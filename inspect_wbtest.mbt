///|
fn inspect_wbtest_request(csv : String) -> Map[String, Json] {
  Map::Map([
    ("op", Json::string("inspect_csv")),
    ("csv", Json::string(csv)),
    ("side", Json::string("left")),
    ("offset", Json::number(0.0)),
    ("limit", Json::number(100.0)),
  ])
}

///|
test "inspect_csv_budget_returns_complete_prefix_and_exact_next_offset" {
  let chars : Array[Char] = []
  for _ in 0..<180 {
    chars.push('x')
  }
  let value = String::from_array(chars)
  let csv = "id,note\n1," +
    value +
    "\n2," +
    value +
    "\n3," +
    value +
    "\n4," +
    value +
    "\n5," +
    value +
    "\n"
  let request = inspect_wbtest_request(csv)
  let result = handle_inspect_csv_with_budget(request, 1200)
  match result {
    Json::Object(fields) =>
      match fields.get("preview") {
        Some(Json::Object(preview)) => {
          let rows = match preview.get("rows") {
            Some(Json::Array(items)) => items
            _ => abort("preview rows missing")
          }
          assert_true(rows.length() > 0)
          assert_true(rows.length() < 5)
          assert_eq(
            preview.get("next_offset").unwrap(),
            Json::number(rows.length().to_double()),
          )
          assert_eq(preview.get("has_more").unwrap(), Json::boolean(true))
          assert_true(inspect_json_utf8_bytes(result) <= 1200)
        }
        _ => abort("preview missing")
      }
    _ => abort("inspect failed to return a page")
  }
}

///|
test "inspect_csv_budget_rejects_headers_or_first_complete_row_that_do_not_fit" {
  let header_chars : Array[Char] = []
  for _ in 0..<400 {
    header_chars.push('h')
  }
  let header_csv = String::from_array(header_chars) + "\n"
  let header_result = handle_inspect_csv_with_budget(
    inspect_wbtest_request(header_csv),
    256,
  )
  assert_true(header_result.stringify().contains("preview_limit_exceeded"))

  let value_chars : Array[Char] = []
  for _ in 0..<256 {
    value_chars.push('x')
  }
  let row_csv = "id,note\n1," + String::from_array(value_chars) + "\n"
  let row_result = handle_inspect_csv_with_budget(
    inspect_wbtest_request(row_csv),
    300,
  )
  assert_true(row_result.stringify().contains("preview_limit_exceeded"))
}

///|
test "inspect_csv_rejects_numeric_values_outside_moonbit_int_before_conversion" {
  let too_large = inspect_wbtest_request("id\n1\n")
  too_large.set("offset", Json::number(2147483648.0))
  match handle_inspect_csv(too_large) {
    Json::Object(fields) =>
      match fields.get("error") {
        Some(Json::Object(error)) =>
          assert_eq(error.get("code").unwrap(), Json::string("invalid_request"))
        _ => abort("expected structured error")
      }
    _ => abort("expected error object")
  }
}

///|
test "inspect_csv_budget_counts_escaped_non_bmp_and_final_envelope_exactly" {
  let request = inspect_wbtest_request("id,note\n1,\"🙂\"\"\\\n尾\"\n")
  let full = handle_inspect_csv(request)
  let exact_bytes = inspect_json_utf8_bytes(full)
  assert_eq(handle_inspect_csv_with_budget(request, exact_bytes), full)
  let too_small = handle_inspect_csv_with_budget(request, exact_bytes - 1)
  assert_true(too_small.stringify().contains("preview_limit_exceeded"))
}
