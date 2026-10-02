///|
test "task3_exact_pair_duplicate_missing_structure_and_conservation" {
  let left = {
    headers: ["code", "region", "old_note", "skip", "left_only"],
    rows: [
      ["001", "A", "left", "x", "u"],
      ["dup", "A", "d1", "x", "u"],
      ["dup", "A", "d2", "x", "u"],
      ["", "B", "m", "x", "u"],
    ],
  }
  let right = {
    headers: ["area", "sku", "new_note", "extra"],
    rows: [
      ["A", "001", "right", "y"],
      ["A", "dup", "d1", "y"],
      ["A", "dup", "d2", "y"],
    ],
  }
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"code\",\"left\":\"code\",\"right\":\"sku\",\"type\":\"text\",\"compare\":false},{\"name\":\"region\",\"left\":\"region\",\"right\":\"area\",\"type\":\"text\",\"compare\":false},{\"name\":\"note\",\"left\":\"old_note\",\"right\":\"new_note\",\"type\":\"text\"}],\"key\":[\"code\",\"region\"],\"ignore_left\":[\"skip\"],\"ignore_right\":[\"extra\"]}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("fixture config invalid")
  }
  let result = compare_tables(left, right, config)
  assert_eq(result.pairs.length(), 1)
  assert_eq(result.pairs[0].left_record, 1)
  assert_eq(result.pairs[0].right_record, 1)
  assert_eq(result.pending_left, 3)
  assert_eq(result.pending_right, 2)
  assert_eq(result.exit_code, 1)
  assert_eq(result.left_total, result.pairs.length() + result.pending_left)
  assert_eq(result.right_total, result.pairs.length() + result.pending_right)
  assert_true(result.diagnostics.length() >= 3)
  let diagnostic_json = Json::array(result.diagnostics).stringify()
  assert_true(
    diagnostic_json.contains(
      "\"code\":\"invalid_or_missing_key\",\"side\":\"left\",\"record\":4",
    ),
  )
  assert_true(
    diagnostic_json.contains(
      "\"code\":\"duplicate_key\",\"side\":\"left\",\"record\":2",
    ),
  )
  assert_true(
    diagnostic_json.contains(
      "\"code\":\"duplicate_key\",\"side\":\"left\",\"record\":3",
    ),
  )
  assert_true(
    diagnostic_json.contains(
      "\"code\":\"duplicate_key\",\"side\":\"right\",\"record\":2",
    ),
  )
  assert_true(
    diagnostic_json.contains(
      "\"code\":\"duplicate_key\",\"side\":\"right\",\"record\":3",
    ),
  )
  assert_true(result.unmapped_left.contains("old_note") == false)
  assert_true(result.unmapped_left.contains("left_only"))
  assert_true(result.ignored_left.contains("skip"))
  assert_true(result.unmapped_right.contains("extra") == false)
}

///|
test "task3_delimiter_key_collision_impossible_and_no_key_pending" {
  let left = { headers: ["a", "b"], rows: [["x|y", "z"], ["x", "y|z"]], }
  let right = { headers: ["a", "b"], rows: [["x|y", "z"], ["x", "y|z"]], }
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"a\",\"right\":\"a\",\"type\":\"text\"},{\"name\":\"b\",\"left\":\"b\",\"right\":\"b\",\"type\":\"text\"}],\"key\":[\"a\",\"b\"]}",
      ),
    ) {
    Ok(v) => v
    Err(_) => abort("fixture config invalid")
  }
  let result = compare_tables(left, right, config)
  assert_eq(result.pairs.length(), 2)

  let no_key = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"a\",\"right\":\"a\",\"type\":\"text\"}],\"key\":[]}",
      ),
    ) {
    Ok(v) => v
    Err(_) => abort("fixture config invalid")
  }
  let pending = compare_tables(
    { headers: ["a"], rows: [["1"]], },
    { headers: ["a"], rows: [["1"]], },
    no_key,
  )
  assert_eq(pending.pairs.length(), 0)
  assert_eq(pending.pending_left, 1)
  assert_eq(pending.pending_right, 1)
}

///|
test "task3_equivalent_only_exit_zero_and_unmapped_column_exit_one" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"id\",\"left\":\"id\",\"right\":\"id\",\"type\":\"text\",\"compare\":false},{\"name\":\"amount\",\"left\":\"amount\",\"right\":\"amount\",\"type\":\"decimal\"}],\"key\":[\"id\"]}",
      ),
    ) {
    Ok(v) => v
    Err(_) => abort("fixture config invalid")
  }
  let equal = compare_tables(
    { headers: ["id", "amount"], rows: [["1", "100.00"]], },
    { headers: ["id", "amount"], rows: [["1", "100"]], },
    config,
  )
  assert_eq(equal.exit_code, 0)
  assert_eq(equal.pairs[0].fields[0].status, "equivalent_by_rule")

  let extra = compare_tables(
    { headers: ["id", "amount", "other"], rows: [["1", "100.00", "x"]], },
    { headers: ["id", "amount"], rows: [["1", "100"]], },
    config,
  )
  assert_eq(extra.exit_code, 1)
  assert_true(extra.unmapped_left.contains("other"))
}

///|
test "task3_invalid_typed_and_empty_text_keys_stay_pending" {
  let decimal_key = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"id\",\"left\":\"id\",\"right\":\"id\",\"type\":\"decimal\"}],\"key\":[\"id\"]}",
      ),
    ) {
    Ok(v) => v
    Err(_) => abort("fixture config invalid")
  }
  let invalid = compare_tables(
    { headers: ["id"], rows: [["NaN"]], },
    { headers: ["id"], rows: [["NaN"]], },
    decimal_key,
  )
  assert_eq(invalid.pairs.length(), 0)
  assert_eq(invalid.pending_left, 1)
  assert_eq(invalid.pending_right, 1)
  assert_eq(invalid.exit_code, 1)

  let text_key = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"id\",\"left\":\"id\",\"right\":\"id\",\"type\":\"text\"}],\"key\":[\"id\"]}",
      ),
    ) {
    Ok(v) => v
    Err(_) => abort("fixture config invalid")
  }
  let empty = compare_tables(
    { headers: ["id"], rows: [[""]], },
    { headers: ["id"], rows: [[""]], },
    text_key,
  )
  assert_eq(empty.pairs.length(), 0)
  assert_eq(empty.pending_left, 1)
  assert_eq(empty.pending_right, 1)
}

///|
test "task3_missing_mandatory_source_column_is_fatal" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"id\",\"left\":\"left_id\",\"right\":\"right_id\",\"type\":\"text\"}],\"key\":[\"id\"]}",
      ),
    ) {
    Ok(v) => v
    Err(_) => abort("fixture config invalid")
  }
  let result = compare_tables(
    { headers: ["other"], rows: [["x"]], },
    { headers: ["right_id"], rows: [["1"]], },
    config,
  )
  assert_eq(result.exit_code, 2)
  assert_eq(result.status, "incomplete")
  assert_true(result.fatal_error is Some(_))
  assert_true(result.diagnostics.length() > 0)
}
