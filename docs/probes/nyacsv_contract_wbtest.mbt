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
