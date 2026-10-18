///|
fn inspect_json_utf8_bytes(value : Json) -> Int {
  let count = Ref(0)
  for ch in value.stringify() {
    count.val += utf8_char_size(ch)
  }
  count.val
}

///|
fn inspect_string_json_utf8_bytes(value : String) -> Int {
  inspect_json_utf8_bytes(Json::string(value))
}

///|
fn inspect_utf8_bytes(value : String) -> Int {
  let count = Ref(0)
  for ch in value {
    count.val += utf8_char_size(ch)
  }
  count.val
}

///|
fn inspect_only_keys(
  object : Map[String, Json],
  allowed : Array[String],
) -> Bool {
  for key, _value in object {
    if !allowed.contains(key) {
      return false
    }
  }
  true
}

///|
fn inspect_required_int(
  object : Map[String, Json],
  key : String,
  minimum : Int,
  maximum : Int,
) -> Result[Int, EngineError] {
  match object.get(key) {
    Some(Json::Number(number, ..)) =>
      // Check bounds before converting: Float.to_int saturates at the Int range.
      if !(number >= minimum.to_double() && number <= maximum.to_double()) {
        Err(
          request_error(
            "invalid_request",
            "request property '\{key}' is out of range",
            Some(key),
          ),
        )
      } else {
        let converted = number.to_int()
        if number != converted.to_double() {
          Err(
            request_error(
              "invalid_request",
              "request property '\{key}' must be an integer",
              Some(key),
            ),
          )
        } else {
          Ok(converted)
        }
      }
    _ =>
      Err(
        request_error(
          "invalid_request",
          "request property '\{key}' must be an integer",
          Some(key),
        ),
      )
  }
}

///|
fn inspect_preview_row(
  table : CsvTable,
  row_index : Int,
  max_json_bytes : Int,
) -> (Json, Int)? {
  let cells : Array[Json] = []
  let row_bytes = Ref(
    inspect_json_utf8_bytes(
      Json::object({
        "record": Json::number((row_index + 1).to_double()),
        "cells": Json::array([]),
      }),
    ),
  )
  for column_index, column in table.headers {
    let value = table.rows[row_index][column_index]
    let characters = value.to_array()
    let truncated = characters.length() > 256
    let preview_value = if truncated {
      String::from_array(characters[:256])
    } else {
      value
    }
    let cell = Json::object({
      "column": Json::string(column),
      "value": Json::string(preview_value),
      "utf8_bytes": Json::number(inspect_utf8_bytes(value).to_double()),
      "truncated": Json::boolean(truncated),
    })
    row_bytes.val += inspect_json_utf8_bytes(cell) +
      (if cells.is_empty() { 0 } else { 1 })
    if row_bytes.val > max_json_bytes {
      return None
    }
    cells.push(cell)
  }
  Some(
    (
      Json::object({
        "record": Json::number((row_index + 1).to_double()),
        "cells": Json::array(cells),
      }),
      row_bytes.val,
    ),
  )
}

///|
fn inspect_preview_envelope(
  side : String,
  headers : Json,
  row_count : Int,
  column_count : Int,
  offset : Int,
  limit : Int,
  rows : Array[Json],
) -> Json {
  let next_offset = offset + rows.length()
  Json::object({
    "ok": Json::boolean(true),
    "preview": Json::object({
      "side": Json::string(side),
      "headers": headers,
      "row_count": Json::number(row_count.to_double()),
      "column_count": Json::number(column_count.to_double()),
      "offset": Json::number(offset.to_double()),
      "limit": Json::number(limit.to_double()),
      "rows": Json::array(rows),
      "next_offset": Json::number(next_offset.to_double()),
      "has_more": Json::boolean(next_offset < row_count),
    }),
  })
}

///|
fn inspect_preview_json(
  side : String,
  table : CsvTable,
  offset : Int,
  limit : Int,
  rows : Array[Json],
) -> Json {
  inspect_preview_envelope(
    side,
    Json::array(table.headers.map(fn(header) { Json::string(header) })),
    table.rows.length(),
    table.headers.length(),
    offset,
    limit,
    rows,
  )
}

///|
fn inspect_preview_headers_fit(
  side : String,
  table : CsvTable,
  offset : Int,
  limit : Int,
  max_json_bytes : Int,
) -> Bool {
  let encoded_headers = Ref(2)
  for index, header in table.headers {
    if index > 0 {
      encoded_headers.val += 1
    }
    encoded_headers.val += inspect_string_json_utf8_bytes(header)
    if encoded_headers.val > max_json_bytes {
      return false
    }
  }
  let empty = inspect_preview_envelope(
    side,
    Json::array([]),
    table.rows.length(),
    table.headers.length(),
    offset,
    limit,
    [],
  )
  inspect_json_utf8_bytes(empty) - 2 + encoded_headers.val <= max_json_bytes
}

///|
fn inspect_page(
  side : String,
  table : CsvTable,
  offset : Int,
  limit : Int,
  max_json_bytes : Int,
) -> Json {
  if !inspect_preview_headers_fit(side, table, offset, limit, max_json_bytes) {
    return error_to_json(
      engine_error(
        "preview_limit_exceeded",
        "CSV headers exceed the JSON preview budget",
        "request",
        side~,
      ),
    )
  }
  let rows : Array[Json] = []
  let empty_bytes = inspect_json_utf8_bytes(
    inspect_preview_json(side, table, offset, limit, []),
  )
  let rows_bytes = Ref(0)
  if offset < table.rows.length() {
    let end = if offset + limit < table.rows.length() {
      offset + limit
    } else {
      table.rows.length()
    }
    for row_index in offset..<end {
      let next_offset = offset + rows.length() + 1
      // The empty envelope already includes [] and offset/has_more. Adjust only
      // those variable-width fields, then budget each cell before building a row.
      let envelope_bytes = empty_bytes +
        inspect_json_utf8_bytes(Json::number(next_offset.to_double())) -
        inspect_json_utf8_bytes(Json::number(offset.to_double())) +
        (if next_offset == table.rows.length() { 1 } else { 0 })
      let comma_bytes = if rows.is_empty() { 0 } else { 1 }
      let available = max_json_bytes -
        envelope_bytes -
        rows_bytes.val -
        comma_bytes
      match inspect_preview_row(table, row_index, available) {
        Some((candidate, candidate_bytes)) => {
          rows.push(candidate)
          rows_bytes.val += candidate_bytes + comma_bytes
        }
        None => {
          if rows.is_empty() {
            return error_to_json(
              engine_error(
                "preview_limit_exceeded",
                "one complete preview row exceeds the JSON preview budget",
                "request",
                side~,
              ),
            )
          }
          break
        }
      }
    }
  }
  inspect_preview_json(side, table, offset, limit, rows)
}

///|
fn inspect_cell(
  side : String,
  table : CsvTable,
  record : Int,
  column : String,
) -> Json {
  let column_index = match table.headers.search(column) {
    Some(index) => index
    None =>
      return error_to_json(
        request_error(
          "invalid_request",
          "cell column does not exist",
          Some("cell.column"),
        ),
      )
  }
  let value = table.rows[record - 1][column_index]
  success_to_json(
    "cell",
    Json::object({
      "side": Json::string(side),
      "record": Json::number(record.to_double()),
      "column": Json::string(column),
      "value": Json::string(value),
      "utf8_bytes": Json::number(inspect_utf8_bytes(value).to_double()),
      "truncated": Json::boolean(false),
    }),
  )
}

///|
fn handle_inspect_csv_with_budget(
  object : Map[String, Json],
  max_json_bytes : Int,
) -> Json {
  let csv = match require_request_string(object, "csv") {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  let side = match require_request_string(object, "side") {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  if side != "left" && side != "right" {
    return error_to_json(
      request_error(
        "invalid_request",
        "side must be 'left' or 'right'",
        Some("side"),
      ),
    )
  }
  let cell_request : (Int, String)? = match object.get("cell") {
    Some(Json::Object(cell)) => {
      if !inspect_only_keys(object, ["op", "csv", "side", "cell"]) ||
        !inspect_only_keys(cell, ["record", "column"]) {
        return error_to_json(
          request_error(
            "invalid_request",
            "cell request contains an unknown or conflicting property",
            Some("cell"),
          ),
        )
      }
      let record = match inspect_required_int(cell, "record", 1, 2147483647) {
        Ok(value) => value
        Err(error) => return error_to_json(error)
      }
      let column = match require_request_string(cell, "column") {
        Ok(value) => value
        Err(error) => return error_to_json(error)
      }
      Some((record, column))
    }
    Some(_) =>
      return error_to_json(
        request_error("invalid_request", "cell must be an object", Some("cell")),
      )
    None => {
      if !inspect_only_keys(object, ["op", "csv", "side", "offset", "limit"]) {
        return error_to_json(
          request_error(
            "invalid_request",
            "page request contains an unknown property",
            None,
          ),
        )
      }
      None
    }
  }
  let page_request : (Int, Int)? = match object.get("cell") {
    Some(_) => None
    None => {
      let offset = match inspect_required_int(object, "offset", 0, 2147483647) {
        Ok(value) => value
        Err(error) => return error_to_json(error)
      }
      let limit = match inspect_required_int(object, "limit", 1, 100) {
        Ok(value) => value
        Err(error) => return error_to_json(error)
      }
      Some((offset, limit))
    }
  }
  let table = match parse_csv(csv, side) {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  match (cell_request, page_request) {
    (Some((record, column)), None) => {
      if record > table.rows.length() {
        return error_to_json(
          request_error(
            "invalid_request",
            "cell record does not exist",
            Some("cell.record"),
          ),
        )
      }
      inspect_cell(side, table, record, column)
    }
    (None, Some((offset, limit))) =>
      inspect_page(side, table, offset, limit, max_json_bytes)
    _ => abort("cell or page request required")
  }
}

///|
fn handle_inspect_csv(object : Map[String, Json]) -> Json {
  handle_inspect_csv_with_budget(object, 2097152)
}
