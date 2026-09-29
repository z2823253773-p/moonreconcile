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
