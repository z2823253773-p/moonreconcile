///|
test "quoted_newline_uses_one_record" {
  match parse_csv("id,note\n001,\"first\nsecond\"\n", "left") {
    Ok(table) => {
      assert_eq(table.rows.length(), 1)
      assert_eq(table.rows[0][0], "001")
      assert_eq(table.rows[0][1], "first\nsecond")
    }
    Err(_) => assert_true(false)
  }
}

///|
test "crlf_and_trailing_empty_preserved" {
  match parse_csv("id,value,extra\r\n1,x,\r\n", "right") {
    Ok(table) => {
      assert_eq(table.headers.length(), 3)
      assert_eq(table.rows.length(), 1)
      assert_eq(table.rows[0][2], "")
    }
    Err(_) => assert_true(false)
  }
}

///|
test "illegal_quote_rejected" {
  match parse_csv("id,value\n1,bad\"quote\n", "left") {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_csv")
  }
}

///|
test "duplicate_or_blank_header_rejected" {
  match parse_csv("id,id\n1,2\n", "left") {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_header")
  }
  match parse_csv("id, \n1,2\n", "left") {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_header")
  }
}

///|
test "unequal_width_reports_record" {
  match parse_csv("id,value\n1,x\n2\n", "right") {
    Ok(_) => assert_true(false)
    Err(error) => {
      assert_eq(error.code, "invalid_row_width")
      assert_eq(error.record, Json::number(3.0))
    }
  }
}

///|
test "csv_column_budget_accepts_exact_limit_and_rejects_over_limit" {
  let exact_headers : Array[String] = []
  let over_headers : Array[String] = []
  for i in 0..<257 {
    if i < 256 {
      exact_headers.push("c\{i}")
    }
    over_headers.push("c\{i}")
  }
  assert_true(parse_csv(exact_headers.join(","), "left") is Ok(_))
  match parse_csv(over_headers.join(","), "left") {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "input_limit_exceeded")
  }
}

///|
test "csv_record_budget_accepts_exact_limit_and_rejects_over_limit" {
  let exact = "id\n" + "1\n".repeat(100000)
  let over = "id\n" + "1\n".repeat(100001)
  assert_eq(parse_csv(exact, "left").unwrap().rows.length(), 100000)
  match parse_csv(over, "left") {
    Ok(_) => assert_true(false)
    Err(error) => {
      assert_eq(error.code, "input_limit_exceeded")
      assert_eq(error.field, Json::string("id"))
    }
  }
}

///|
test "csv_cell_budget_counts_utf8_bytes_and_checks_exact_boundary" {
  let exact = "id\n" + "é".repeat(32768) + "\n"
  let over = "id\n" + "é".repeat(32769) + "\n"
  assert_eq(parse_csv(exact, "left").unwrap().rows[0][0].length(), 32768)
  match parse_csv(over, "left") {
    Ok(_) => assert_true(false)
    Err(error) => {
      assert_eq(error.code, "input_limit_exceeded")
      assert_eq(error.field, Json::string("id"))
    }
  }
}

///|
test "csv_syntax_error_identifies_field" {
  match parse_csv("id,note\n1,bad\"quote\n", "left") {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.field, Json::string("note"))
  }
}

///|
test "csv_total_byte_budget_counts_multibyte_utf8_at_boundary" {
  assert_true(within_utf8_budget("é".repeat(32), 64))
  assert_true(!within_utf8_budget("é".repeat(33), 64))
}

///|
test "csv_private_raw_budget_counts_header_bom_utf8_and_separators" {
  let csv = "\u{FEFF}id\r\né\r\n"
  assert_eq(parse_csv_with_budget(csv, "left", 11, 1).unwrap().rows.length(), 1)
  assert_true(parse_csv_with_budget(csv, "left", 10, 1) is Err(_))
  assert_true(parse_csv_with_budget(csv, "left", 11, 0) is Err(_))
}
