///|
fn header_index(table : Table, name : String) -> Int? {
  for index, header in table.headers {
    if header == name {
      return Some(index)
    }
  }
  None
}

///|
fn key_for_row(
  table : Table,
  row_index : Int,
  side : String,
  config : Config,
) -> String? {
  let parts : Array[Json] = []
  for key_name in config.key {
    let field = {
      let mut found : FieldConfig? = None
      for candidate in config.fields {
        if candidate.name == key_name {
          found = Some(candidate)
        }
      }
      match found {
        Some(value) => value
        None => return None
      }
    }
    let source = if side == "left" { field.left } else { field.right }
    let column = match header_index(table, source) {
      Some(value) => value
      None => return None
    }
    let raw = table.rows[row_index][column]
    let value = normalize_value(raw, field, side)
    if value.invalid ||
      value.missing ||
      (field.field_type == "text" && value.transformed.is_empty()) {
      return None
    }
    parts.push(Json::string(value.canonical.unwrap()))
  }
  Some(Json::array(parts).stringify())
}

///|
fn row_key_usable(
  table : Table,
  row_index : Int,
  side : String,
  config : Config,
) -> Bool {
  key_for_row(table, row_index, side, config) is Some(_)
}

///|
fn add_key_index(
  index : Map[String, Array[Int]],
  table : Table,
  side : String,
  config : Config,
) -> Unit {
  for row_index in 0..<table.rows.length() {
    match key_for_row(table, row_index, side, config) {
      Some(key) =>
        match index.get(key) {
          Some(indices) => indices.push(row_index)
          None => index[key] = [row_index]
        }
      None => ()
    }
  }
}

///|
fn diagnostic(
  code : String,
  side : String,
  record : Int?,
  field : String?,
  message : String,
) -> Json {
  Json::object({
    "code": Json::string(code),
    "side": match side {
      "" => Json::null()
      _ => Json::string(side)
    },
    "record": match record {
      Some(value) => Json::number((value + 1).to_double())
      None => Json::null()
    },
    "field": match field {
      Some(value) => Json::string(value)
      None => Json::null()
    },
    "message": Json::string(message),
  })
}

///|
fn missing_columns(
  table : Table,
  config : Config,
  side : String,
) -> Array[String] {
  let missing : Array[String] = []
  for field in config.fields {
    let source = if side == "left" { field.left } else { field.right }
    if !table.headers.contains(source) && !missing.contains(source) {
      missing.push(source)
    }
  }
  missing
}

///|
fn record_numbers(count : Int) -> Array[Int] {
  let records : Array[Int] = []
  for index in 0..<count {
    records.push(index + 1)
  }
  records
}

///|
fn missing_ignored_columns(
  table : Table,
  ignored : Array[String],
) -> Array[String] {
  ignored.filter(fn(column) { !table.headers.contains(column) })
}

///|
fn unmapped_columns(
  table : Table,
  config : Config,
  side : String,
) -> Array[String] {
  let result : Array[String] = []
  for header in table.headers {
    let mapped = config.fields.any(fn(field) {
      if side == "left" {
        field.left == header
      } else {
        field.right == header
      }
    })
    let ignored = if side == "left" {
      config.ignore_left.contains(header)
    } else {
      config.ignore_right.contains(header)
    }
    if !mapped && !ignored {
      result.push(header)
    }
  }
  result
}

///|
fn compare_tables_with_budget(
  left : Table,
  right : Table,
  config : Config,
  budget : CandidateBudget,
) -> ReconciliationResult {
  let diagnostics : Array[Json] = []
  let missing_left = missing_columns(left, config, "left")
  let missing_right = missing_columns(right, config, "right")
  let missing_ignored_left = missing_ignored_columns(left, config.ignore_left)
  let missing_ignored_right = missing_ignored_columns(
    right,
    config.ignore_right,
  )
  if !missing_left.is_empty() ||
    !missing_right.is_empty() ||
    !missing_ignored_left.is_empty() ||
    !missing_ignored_right.is_empty() {
    for column in missing_left {
      diagnostics.push(
        diagnostic(
          "missing_mandatory_column",
          "left",
          None,
          Some(column),
          "configured source column is absent",
        ),
      )
    }
    for column in missing_right {
      diagnostics.push(
        diagnostic(
          "missing_mandatory_column",
          "right",
          None,
          Some(column),
          "configured source column is absent",
        ),
      )
    }
    for column in missing_ignored_left {
      diagnostics.push(
        diagnostic(
          "missing_ignored_column",
          "left",
          None,
          Some(column),
          "declared ignored column is absent",
        ),
      )
    }
    for column in missing_ignored_right {
      diagnostics.push(
        diagnostic(
          "missing_ignored_column",
          "right",
          None,
          Some(column),
          "declared ignored column is absent",
        ),
      )
    }
    let (code, side, column, message) = if !missing_left.is_empty() {
      (
        "missing_mandatory_column",
        "left",
        missing_left[0],
        "configured source column is absent",
      )
    } else if !missing_right.is_empty() {
      (
        "missing_mandatory_column",
        "right",
        missing_right[0],
        "configured source column is absent",
      )
    } else if !missing_ignored_left.is_empty() {
      (
        "missing_ignored_column",
        "left",
        missing_ignored_left[0],
        "declared ignored column is absent",
      )
    } else {
      (
        "missing_ignored_column",
        "right",
        missing_ignored_right[0],
        "declared ignored column is absent",
      )
    }
    let error = engine_error(
      code,
      "\{message}: '\{column}' on \{side}",
      "configuration",
      side~,
      field=column,
    )
    return {
      status: "incomplete",
      exit_code: 2,
      left_total: left.rows.length(),
      right_total: right.rows.length(),
      pairs: [],
      pending_left: left.rows.length(),
      pending_right: right.rows.length(),
      pending_left_records: record_numbers(left.rows.length()),
      pending_right_records: record_numbers(right.rows.length()),
      diagnostics,
      candidates: [],
      computation_issues: [],
      unprocessed_left_records: [],
      unprocessed_right_records: [],
      unmatched_left_records: [],
      unmatched_right_records: [],
      decisions: [],
      unmapped_left: [],
      unmapped_right: [],
      ignored_left: config.ignore_left.copy(),
      ignored_right: config.ignore_right.copy(),
      fatal_error: Some(error),
    }
  }

  let unmapped_left = unmapped_columns(left, config, "left")
  let unmapped_right = unmapped_columns(right, config, "right")
  for column in unmapped_left {
    diagnostics.push(
      diagnostic(
        "unmapped_column",
        "left",
        None,
        Some(column),
        "column is neither mapped nor explicitly ignored",
      ),
    )
  }
  for column in unmapped_right {
    diagnostics.push(
      diagnostic(
        "unmapped_column",
        "right",
        None,
        Some(column),
        "column is neither mapped nor explicitly ignored",
      ),
    )
  }
  let ignored_left = config.ignore_left.filter(fn(column) {
    left.headers.contains(column)
  })
  let ignored_right = config.ignore_right.filter(fn(column) {
    right.headers.contains(column)
  })

  let left_keys : Map[String, Array[Int]] = Map([])
  let right_keys : Map[String, Array[Int]] = Map([])
  if !config.key.is_empty() {
    add_key_index(left_keys, left, "left", config)
    add_key_index(right_keys, right, "right", config)
  }
  let pairs : Array[ExactPair] = []
  let left_paired = Array::make(left.rows.length(), false)
  let right_paired = Array::make(right.rows.length(), false)

  if config.key.is_empty() {
    diagnostics.push(
      diagnostic(
        "no_key_configured",
        "",
        None,
        None,
        "all records remain pending because no exact key is configured",
      ),
    )
  } else {
    for row_index in 0..<left.rows.length() {
      match key_for_row(left, row_index, "left", config) {
        Some(key) =>
          match (left_keys.get(key), right_keys.get(key)) {
            (Some([left_index]), Some([right_index])) => {
              let comparisons : Array[FieldComparison] = []
              for field in config.fields {
                if field.compare {
                  let li = header_index(left, field.left).unwrap()
                  let ri = header_index(right, field.right).unwrap()
                  comparisons.push(
                    compare_field(
                      left.rows[left_index][li],
                      right.rows[right_index][ri],
                      field,
                    ),
                  )
                }
              }
              pairs.push({
                left_record: left_index + 1,
                right_record: right_index + 1,
                source: "exact_key",
                reason: "unique_canonical_key",
                is_override: false,
                fields: comparisons,
              })
              left_paired[left_index] = true
              right_paired[right_index] = true
            }
            _ => ()
          }
        None =>
          diagnostics.push(
            diagnostic(
              "invalid_or_missing_key",
              "left",
              Some(row_index),
              None,
              "record has a missing, empty, or invalid typed key component",
            ),
          )
      }
    }
    for row_index in 0..<right.rows.length() {
      if !row_key_usable(right, row_index, "right", config) {
        diagnostics.push(
          diagnostic(
            "invalid_or_missing_key",
            "right",
            Some(row_index),
            None,
            "record has a missing, empty, or invalid typed key component",
          ),
        )
      } else {
        let key = key_for_row(right, row_index, "right", config).unwrap()
        match right_keys.get(key) {
          Some(indices) if indices.length() > 1 =>
            diagnostics.push(
              diagnostic(
                "duplicate_key",
                "right",
                Some(row_index),
                None,
                "key occurs more than once on right",
              ),
            )
          _ => ()
        }
      }
    }
    for row_index in 0..<left.rows.length() {
      if row_key_usable(left, row_index, "left", config) {
        let key = key_for_row(left, row_index, "left", config).unwrap()
        match left_keys.get(key) {
          Some(indices) if indices.length() > 1 =>
            diagnostics.push(
              diagnostic(
                "duplicate_key",
                "left",
                Some(row_index),
                None,
                "key occurs more than once on left",
              ),
            )
          _ => ()
        }
      }
    }
    for row_index in 0..<left.rows.length() {
      if !row_key_usable(left, row_index, "left", config) {
        ()
      } else {
        let key = key_for_row(left, row_index, "left", config).unwrap()
        match right_keys.get(key) {
          None =>
            diagnostics.push(
              diagnostic(
                "key_not_found",
                "left",
                Some(row_index),
                None,
                "no right record has this key; record remains pending",
              ),
            )
          _ => ()
        }
      }
    }
    for row_index in 0..<right.rows.length() {
      if row_key_usable(right, row_index, "right", config) {
        let key = key_for_row(right, row_index, "right", config).unwrap()
        match left_keys.get(key) {
          None =>
            diagnostics.push(
              diagnostic(
                "key_not_found",
                "right",
                Some(row_index),
                None,
                "no left record has this key; record remains pending",
              ),
            )
          _ => ()
        }
      }
    }
  }

  let pending_left = left.rows.length() - pairs.length()
  let pending_right = right.rows.length() - pairs.length()
  let pending_left_records : Array[Int] = []
  let pending_right_records : Array[Int] = []
  for row_index in 0..<left.rows.length() {
    if !left_paired[row_index] {
      pending_left_records.push(row_index + 1)
    }
  }
  for row_index in 0..<right.rows.length() {
    if !right_paired[row_index] {
      pending_right_records.push(row_index + 1)
    }
  }
  let mut has_field_issue = false
  for pair in pairs {
    for field in pair.fields {
      if field.status == "different" || field.status == "invalid_value" {
        has_field_issue = true
      }
    }
  }
  let exit_code = if !unmapped_left.is_empty() ||
    !unmapped_right.is_empty() ||
    has_field_issue ||
    pending_left > 0 ||
    pending_right > 0 ||
    diagnostics.any(fn(d) {
      match d {
        Json::Object(fields) =>
          fields.get("code") == Some(Json::string("duplicate_key")) ||
          fields.get("code") == Some(Json::string("invalid_or_missing_key"))
        _ => false
      }
    }) {
    1
  } else {
    0
  }
  let candidate_stage = if config.candidates is Json::Object(_) &&
    (pending_left > 0 || pending_right > 0) {
    generate_candidates_with_budget(
      left, right, pending_left_records, pending_right_records, config, budget,
    )
  } else {
    { candidates: [], issues: [], unprocessed_left: [], unprocessed_right: [] }
  }
  let candidate_incomplete = !candidate_stage.unprocessed_left.is_empty() ||
    !candidate_stage.unprocessed_right.is_empty()
  {
    status: if candidate_incomplete {
      "incomplete"
    } else {
      "complete"
    },
    exit_code: if candidate_incomplete {
      3
    } else {
      exit_code
    },
    left_total: left.rows.length(),
    right_total: right.rows.length(),
    pairs,
    pending_left: pending_left - candidate_stage.unprocessed_left.length(),
    pending_right: pending_right - candidate_stage.unprocessed_right.length(),
    pending_left_records,
    pending_right_records,
    diagnostics,
    candidates: candidate_stage.candidates,
    computation_issues: candidate_stage.issues,
    unprocessed_left_records: candidate_stage.unprocessed_left,
    unprocessed_right_records: candidate_stage.unprocessed_right,
    unmatched_left_records: [],
    unmatched_right_records: [],
    decisions: [],
    unmapped_left,
    unmapped_right,
    ignored_left,
    ignored_right,
    fatal_error: None,
  }
}

///|
pub fn compare_tables(
  left : Table,
  right : Table,
  config : Config,
) -> ReconciliationResult {
  compare_tables_with_budget(left, right, config, {
    pairs: 100000,
    edit_cells: 20000000,
    max_component_side: 100,
    max_edit_codepoints: 512,
  })
}
