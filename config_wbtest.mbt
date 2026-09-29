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
