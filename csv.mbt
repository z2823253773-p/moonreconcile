///|
fn utf8_char_size(ch : Char) -> Int {
  if ch <= '\u{007F}' {
    1
  } else if ch <= '\u{07FF}' {
    2
  } else if ch <= '\u{FFFF}' {
    3
  } else {
    4
  }
}

///|
fn within_utf8_budget(text : String, limit : Int) -> Bool {
  let byte_count = Ref(0)
  for ch in text {
    byte_count.val += utf8_char_size(ch)
    if byte_count.val > limit {
      return false
    }
  }
  true
}

///|
fn parse_csv(text : String, side : String) -> Result[CsvTable, EngineError] {
  if !within_utf8_budget(text, 67108864) {
    return Err(
      engine_error(
        "input_limit_exceeded",
        "CSV input exceeds the 64 MiB text limit",
        "input",
        side~,
      ),
    )
  }
  let input = if text.has_prefix("\u{FEFF}") {
    text[1:].to_owned()
  } else {
    text
  }
  let chars = input.to_array()
  let rows : Array[Array[String]] = []
  let row : Array[String] = []
  let field_chars : Array[Char] = []
  let state = Ref(0) // 0=start, 1=unquoted, 2=quoted, 3=after quote
  let i = Ref(0)
  let logical_record = Ref(1)
  let record_touched = Ref(false)
  let field_byte_count = Ref(0)
  let failure = Ref(None)

  fn field_name() -> String {
    if rows.length() > 0 && row.length() < rows[0].length() {
      rows[0][row.length()]
    } else {
      "column_\{row.length() + 1}"
    }
  }

  fn append_field_char(ch : Char, byte_size : Int) -> Unit {
    field_byte_count.val += byte_size
    if field_byte_count.val > 65536 {
      failure.val = Some(
        engine_error(
          "input_limit_exceeded",
          "CSV cell exceeds the 64 KiB UTF-8 limit",
          "input",
          side~,
          record=logical_record.val,
          field=field_name(),
        ),
      )
    } else {
      field_chars.push(ch)
    }
  }

  fn finish_field() -> Unit {
    if row.length() >= 256 {
      failure.val = Some(
        engine_error(
          "input_limit_exceeded",
          "CSV exceeds the 256-column limit",
          "input",
          side~,
          record=logical_record.val,
          field=field_name(),
        ),
      )
    } else {
      row.push(String::from_array(field_chars[:]))
      field_chars.clear()
      field_byte_count.val = 0
      state.val = 0
    }
  }

  fn finish_record() -> Unit {
    if rows.length() >= 100001 {
      failure.val = Some(
        engine_error(
          "input_limit_exceeded",
          "CSV exceeds the 100000 data-record limit",
          "input",
          side~,
          record=logical_record.val,
          field=field_name(),
        ),
      )
    } else {
      finish_field()
      if failure.val is None {
        rows.push(row.copy())
        row.clear()
        logical_record.val += 1
        record_touched.val = false
      }
    }
  }

  while i.val < chars.length() && failure.val is None {
    let ch = chars[i.val]
    match state.val {
      0 =>
        match ch {
          '"' => {
            state.val = 2
            record_touched.val = true
            i.val += 1
          }
          ',' => {
            finish_field()
            record_touched.val = true
            i.val += 1
          }
          '\n' => {
            finish_record()
            i.val += 1
          }
          '\r' => {
            finish_record()
            i.val += 1
            if i.val < chars.length() && chars[i.val] == '\n' {
              i.val += 1
            }
          }
          _ => {
            append_field_char(ch, utf8_char_size(ch))
            state.val = 1
            record_touched.val = true
            i.val += 1
          }
        }
      1 =>
        match ch {
          ',' => {
            finish_field()
            record_touched.val = true
            i.val += 1
          }
          '\n' => {
            finish_record()
            i.val += 1
          }
          '\r' => {
            finish_record()
            i.val += 1
            if i.val < chars.length() && chars[i.val] == '\n' {
              i.val += 1
            }
          }
          '"' =>
            failure.val = Some(
              engine_error(
                "invalid_csv",
                "quote is not allowed inside an unquoted field",
                "input",
                side~,
                record=logical_record.val,
                field=field_name(),
              ),
            )
          _ => {
            append_field_char(ch, utf8_char_size(ch))
            i.val += 1
          }
        }
      2 =>
        match ch {
          '"' =>
            if i.val + 1 < chars.length() && chars[i.val + 1] == '"' {
              append_field_char('"', 1)
              i.val += 2
            } else {
              state.val = 3
              i.val += 1
            }
          '\r' => {
            append_field_char('\r', 1)
            if i.val + 1 < chars.length() && chars[i.val + 1] == '\n' {
              append_field_char('\n', 1)
              i.val += 2
            } else {
              i.val += 1
            }
          }
          _ => {
            append_field_char(ch, utf8_char_size(ch))
            i.val += 1
          }
        }
      _ =>
        match ch {
          ',' => {
            finish_field()
            record_touched.val = true
            i.val += 1
          }
          '\n' => {
            finish_record()
            i.val += 1
          }
          '\r' => {
            finish_record()
            i.val += 1
            if i.val < chars.length() && chars[i.val] == '\n' {
              i.val += 1
            }
          }
          _ =>
            failure.val = Some(
              engine_error(
                "invalid_csv",
                "only a delimiter or record separator may follow a closing quote",
                "input",
                side~,
                record=logical_record.val,
                field=field_name(),
              ),
            )
        }
    }
  }

  match failure.val {
    Some(error) => return Err(error)
    None => ()
  }
  if state.val == 2 {
    return Err(
      engine_error(
        "invalid_csv",
        "quoted field is not closed",
        "input",
        side~,
        record=logical_record.val,
        field=field_name(),
      ),
    )
  }
  if record_touched.val || row.length() > 0 || field_chars.length() > 0 {
    finish_record()
  }
  match failure.val {
    Some(error) => return Err(error)
    None => ()
  }
  if rows.length() == 0 {
    return Err(engine_error("invalid_csv", "CSV is empty", "input", side~))
  }

  let header_row = rows[0]
  let headers = header_row.copy()
  for column_index, header in headers {
    if header.is_blank() {
      return Err(
        engine_error(
          "invalid_header",
          "header names must not be blank",
          "input",
          side~,
          record=1,
          field="column_\{column_index + 1}",
        ),
      )
    }
    for earlier_index in 0..<column_index {
      if headers[earlier_index] == header {
        return Err(
          engine_error(
            "invalid_header",
            "duplicate header name: \{header}",
            "input",
            side~,
            record=1,
            field=header,
          ),
        )
      }
    }
  }
  let data_rows : Array[Array[String]] = []
  for row_index in 1..<rows.length() {
    let data_row = rows[row_index]
    if data_row.length() != headers.length() {
      return Err(
        engine_error(
          "invalid_row_width",
          "record has \{data_row.length()} fields but header has \{headers.length()}",
          "input",
          side~,
          record=row_index + 1,
        ),
      )
    }
    data_rows.push(data_row)
  }
  Ok({ headers, rows: data_rows, })
}
