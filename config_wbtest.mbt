///|
test "duplicate_mapping_rejected" {
  let config = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"text\"},{\"name\":\"b\",\"left\":\"X\",\"right\":\"Z\",\"type\":\"text\"}]}",
  )
  match parse_config(config) {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_config")
  }
}

///|
test "unknown_rule_rejected" {
  let config = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"text\"}],\"unknown_rule\":true}",
  )
  match parse_config(config) {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_config")
  }
}

///|
test "unknown_field_property_rejected" {
  let config = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"text\",\"fuzzy\":true}]}",
  )
  match parse_config(config) {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_config")
  }
}

///|
test "draft_config_is_rejected_until_edited" {
  let config = @json.parse(
    "{\"schema_version\":1,\"draft\":true,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"text\"}]}",
  )
  match parse_config(config) {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_config")
  }
}

///|
test "init_draft_does_not_infer_key_or_type" {
  match
    (parse_csv("id,name\n1,a\n", "left"), parse_csv("id,label\n1,a\n", "right")) {
    (Ok(left), Ok(right)) => {
      let draft = build_draft_config(left, right)
      match draft {
        Json::Object(fields) => {
          assert_eq(fields.get("draft").unwrap(), Json::boolean(true))
          assert_eq(fields.get("key").unwrap(), Json::array([]))
          assert_eq(fields.get("candidates").unwrap(), Json::null())
          match fields.get("fields").unwrap() {
            Json::Array(items) => {
              // "id" on both sides, "name" left-only, "label" right-only.
              assert_eq(items.length(), 3)
              for item in items {
                match item {
                  Json::Object(field) =>
                    // No type may be inferred; the draft stays unexecutable.
                    assert_eq(field.get("type").unwrap(), Json::null())
                  _ => assert_true(false)
                }
              }
              match items[0] {
                Json::Object(field) => {
                  assert_eq(field.get("name").unwrap(), Json::string("id"))
                  assert_eq(field.get("left").unwrap(), Json::string("id"))
                  assert_eq(field.get("right").unwrap(), Json::string("id"))
                }
                _ => assert_true(false)
              }
              // A header present on only one side must not be mapped on the other.
              match items[1] {
                Json::Object(field) => {
                  assert_eq(field.get("left").unwrap(), Json::string("name"))
                  assert_eq(field.get("right").unwrap(), Json::null())
                }
                _ => assert_true(false)
              }
              match items[2] {
                Json::Object(field) => {
                  assert_eq(field.get("left").unwrap(), Json::null())
                  assert_eq(field.get("right").unwrap(), Json::string("label"))
                }
                _ => assert_true(false)
              }
            }
            _ => assert_true(false)
          }
        }
        _ => assert_true(false)
      }
    }
    _ => assert_true(false)
  }
}

///|
test "normalize_config_is_canonical" {
  let config = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"decimal\"}]}",
  )
  match parse_config(config) {
    Ok(parsed) => {
      let normalized = normalize_config(parsed)
      match normalized {
        Json::Object(fields) => {
          assert_eq(fields.get("schema_version").unwrap(), Json::number(1.0))
          assert_eq(fields.get("draft").unwrap(), Json::boolean(false))
          assert_eq(fields.get("key").unwrap(), Json::array([]))
          match fields.get("fields").unwrap() {
            Json::Array(items) =>
              match items[0] {
                Json::Object(field) => {
                  // Defaults must be materialized explicitly, not left absent.
                  assert_eq(field.get("compare").unwrap(), Json::boolean(true))
                  assert_eq(
                    field.get("trim_ascii").unwrap(),
                    Json::boolean(false),
                  )
                  assert_eq(field.get("missing").unwrap(), Json::array([]))
                  assert_eq(
                    field.get("both_missing").unwrap(),
                    Json::string("equal"),
                  )
                  assert_eq(field.get("abs_tol").unwrap(), Json::string("0"))
                  assert_eq(field.get("rel_tol").unwrap(), Json::string("0"))
                  assert_eq(field.get("days_tol").unwrap(), Json::number(0.0))
                }
                _ => assert_true(false)
              }
            _ => assert_true(false)
          }
        }
        _ => assert_true(false)
      }
    }
    Err(_) => assert_true(false)
  }
}

///|
test "present_wrong_typed_rule_is_rejected" {
  for
    field_property in [
      "\"abs_tol\":4", "\"rel_tol\":true", "\"both_missing\":null",
    ] {
    let config = @json.parse(
      "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"decimal\",\{field_property}}]}",
    )
    match parse_config(config) {
      Ok(_) => assert_true(false)
      Err(error) => assert_eq(error.code, "invalid_config")
    }
  }
}

///|
test "irrelevant_nondefault_tolerances_are_rejected" {
  let cases = [
    ("text", "\"abs_tol\":\"1\""),
    ("text", "\"days_tol\":3"),
    ("date", "\"abs_tol\":\"1\""),
    ("decimal", "\"days_tol\":1"),
  ]
  for item in cases {
    let (field_type, property) = item
    let config = @json.parse(
      "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"\{field_type}\",\{property}}]}",
    )
    match parse_config(config) {
      Ok(_) => assert_true(false)
      Err(error) => assert_eq(error.code, "invalid_config")
    }
  }
}

///|
test "days_tolerance_rejects_integer_overflow_without_saturation" {
  let config = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"date\",\"days_tol\":2147483648}]}",
  )
  match parse_config(config) {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_config")
  }
  let maximum = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"date\",\"days_tol\":2147483647}]}",
  )
  match parse_config(maximum) {
    Ok(parsed) => assert_eq(parsed.fields[0].days_tol, 2147483647)
    Err(_) => assert_true(false)
  }
}

///|
test "identity_only_field_accepts_explicit_value_mapping" {
  let config = @json.parse(
    "{\"schema_version\":1,\"key\":[\"id\"],\"fields\":[{\"name\":\"id\",\"left\":\"id\",\"right\":\"id\",\"type\":\"text\",\"compare\":false,\"left_values\":{\"A\":\"B\"}}]}",
  )
  match parse_config(config) {
    Ok(parsed) => assert_eq(parsed.fields[0].left_values.get("A"), Some("B"))
    Err(_) => assert_true(false)
  }
}

///|
test "decimal_tolerances_enforce_input_digit_and_scale_limits" {
  let cases = [("abs_tol", "1".repeat(65)), ("rel_tol", "0." + "1".repeat(19))]
  for item in cases {
    let (property, value) = item
    let config = @json.parse(
      "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"decimal\",\"\{property}\":\"\{value}\"}]}",
    )
    match parse_config(config) {
      Ok(_) => assert_true(false)
      Err(error) => assert_eq(error.code, "invalid_config")
    }
  }
  let digits64 = "1".repeat(64)
  let digits18 = "1".repeat(18)
  let edge_json = "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"decimal\",\"abs_tol\":\"" +
    digits64 +
    "\",\"rel_tol\":\"0." +
    digits18 +
    "\"}]}"
  let edge = @json.parse(edge_json)
  match parse_config(edge) {
    Ok(_) => ()
    Err(_) => assert_true(false)
  }
}

///|
test "decimal_tolerance_accepts_optional_positive_sign_but_rejects_negative" {
  let positive = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"decimal\",\"abs_tol\":\"+0.01\"}]}",
  )
  match parse_config(positive) {
    Ok(parsed) => assert_eq(parsed.fields[0].abs_tol, "+0.01")
    Err(_) => assert_true(false)
  }
  let negative = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"decimal\",\"abs_tol\":\"-0.01\"}]}",
  )
  match parse_config(negative) {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_config")
  }
}

///|
test "omitted_and_empty_blocking_normalize_equally" {
  let omitted = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"a\",\"metric\":\"exact\",\"weight\":1}],\"threshold\":1}}",
  )
  let explicit = @json.parse(
    "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"X\",\"right\":\"Y\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"a\",\"metric\":\"exact\",\"weight\":1}],\"threshold\":1,\"blocking\":[]}}",
  )
  match (parse_config(omitted), parse_config(explicit)) {
    (Ok(left), Ok(right)) => {
      assert_eq(normalize_config(left), normalize_config(right))
      match parse_config(normalize_config(left)) {
        Ok(roundtrip) =>
          assert_eq(normalize_config(roundtrip), normalize_config(right))
        Err(_) => assert_true(false)
      }
    }
    _ => assert_true(false)
  }
}
