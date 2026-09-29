///|
fn parse_csv(text : String, side : String) -> Result[CsvTable, EngineError] {
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
  let failure = Ref(None)

  fn finish_field() -> Unit {
    row.push(String::from_array(field_chars[:]))
    field_chars.clear()
    state.val = 0
  }

  fn finish_record() -> Unit {
    finish_field()
    rows.push(row.copy())
    row.clear()
    logical_record.val += 1
    record_touched.val = false
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
            field_chars.push(ch)
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
              ),
            )
          _ => {
            field_chars.push(ch)
            i.val += 1
          }
        }
      2 =>
        match ch {
          '"' =>
            if i.val + 1 < chars.length() && chars[i.val + 1] == '"' {
              field_chars.push('"')
              i.val += 2
            } else {
              state.val = 3
              i.val += 1
            }
          '\r' => {
            field_chars.push('\r')
            if i.val + 1 < chars.length() && chars[i.val + 1] == '\n' {
              field_chars.push('\n')
              i.val += 2
            } else {
              i.val += 1
            }
          }
          _ => {
            field_chars.push(ch)
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
      ),
    )
  }
  if record_touched.val || row.length() > 0 || field_chars.length() > 0 {
    finish_record()
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
  Ok({ headers, rows: data_rows })
}
