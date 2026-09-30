///|
test "unterminated_quote_is_accepted" {
  let csv = parse_text("id,note\n1,\"bad")
  assert_eq(csv.data().length(), 1)
  assert_eq(csv.data()[0][1], "bad")
}

///|
test "quote_inside_unquoted_field_is_accepted" {
  let csv = parse_text("id,note\n1,bad\"quote")
  assert_eq(csv.data()[0][1], "bad\"quote")
}

///|
test "quoted_crlf_and_trailing_empty_preserved" {
  let csv = parse_text("id,note,tail\r\n1,\"a\r\nb\",")
  assert_eq(csv.data().length(), 1)
  assert_eq(csv.data()[0][1], "a\r\nb")
  assert_eq(csv.data()[0][2], "")
}

///|
test "duplicate_header_is_accepted" {
  let csv = parse_text("id,id\n1,2\n")
  assert_eq(csv.header()[0], "id")
  assert_eq(csv.header()[1], "id")
}

///|
test "empty_line_is_skipped_by_default" {
  let csv = parse_text("id,note\n1,a\n\n2,b\n")
  assert_eq(csv.data().length(), 2)
}

///|
test "blank_header_is_accepted" {
  let csv = parse_text(",id\nleft,1\n")
  assert_eq(csv.header()[0], "")
  assert_eq(csv.header()[1], "id")
}

///|
test "multiline_record_counts_as_one_data_row" {
  let csv = parse_text("id,note\n1,\"line one\nline two\"\n2,plain\n")
  assert_eq(csv.data().length(), 2)
  assert_eq(csv.data()[0][1], "line one\nline two")
  assert_eq(csv.data()[1][0], "2")
}

///|
test "terminal_newline_adds_no_data_record" {
  let csv = parse_text("id\n1\n")
  assert_eq(csv.data().length(), 1)
}
