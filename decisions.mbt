///|
fn decision_error(
  code : String,
  message : String,
  record : Int?,
) -> EngineError {
  match record {
    Some(value) => engine_error(code, message, "decisions", record=value)
    None => engine_error(code, message, "decisions")
  }
}

///|
fn parse_decision_id(
  value : String,
  expected_side : String,
  csv_record : Int,
) -> Result[Int, EngineError] {
  let prefix = if expected_side == "left" { "L" } else { "R" }
  if value.length() < 2 || !value.has_prefix(prefix) {
    return Err(
      decision_error(
        "invalid_decision",
        "record ID must use the \{prefix}N form",
        Some(csv_record),
      ),
    )
  }
  let digits = value.to_array()[1:]
  let mut number = 0
  if digits.is_empty() {
    return Err(
      decision_error(
        "invalid_decision",
        "record ID must contain a positive canonical integer",
        Some(csv_record),
      ),
    )
  }
  for ch in digits {
    if ch < '0' || ch > '9' {
      return Err(
        decision_error(
          "invalid_decision",
          "record ID must contain a positive canonical integer",
          Some(csv_record),
        ),
      )
    }
    let digit = ch.to_int() - '0'.to_int()
    if number > (2147483647 - digit) / 10 {
      return Err(
        decision_error(
          "invalid_decision",
          "record ID is outside the supported range",
          Some(csv_record),
        ),
      )
    }
    number = number * 10 + digit
  }
  if number <= 0 || number.to_string() != String::from_array(digits) {
    return Err(
      decision_error(
        "invalid_decision",
        "record ID must use canonical positive decimal notation",
        Some(csv_record),
      ),
    )
  }
  Ok(number)
}

///|
pub fn parse_decisions(csv : String) -> Result[Array[Decision], EngineError] {
  let table = match parse_csv(csv, "decisions") {
    Ok(value) => value
    Err(error) => return Err(error)
  }
  if table.headers != ["action", "left_id", "right_id", "reason"] {
    return Err(
      decision_error(
        "invalid_decision_schema",
        "decision CSV header must be exactly action,left_id,right_id,reason",
        None,
      ),
    )
  }
  let decisions : Array[Decision] = []
  for row_index in 0..<table.rows.length() {
    let row = table.rows[row_index]
    let action = row[0]
    if action == "" {
      continue
    }
    let csv_record = row_index + 1
    let left_id = row[1]
    let right_id = row[2]
    let reason = row[3]
    let mut left_record : Int? = None
    let mut right_record : Int? = None
    match action {
      "accept" | "reject" => {
        if left_id == "" || right_id == "" {
          return Err(
            decision_error(
              "invalid_decision",
              "\{action} requires both left_id and right_id",
              Some(csv_record),
            ),
          )
        }
        left_record = match parse_decision_id(left_id, "left", csv_record) {
          Ok(value) => Some(value)
          Err(error) => return Err(error)
        }
        right_record = match parse_decision_id(right_id, "right", csv_record) {
          Ok(value) => Some(value)
          Err(error) => return Err(error)
        }
      }
      "left_unmatched" => {
        if left_id == "" || right_id != "" {
          return Err(
            decision_error(
              "invalid_decision",
              "left_unmatched requires only left_id",
              Some(csv_record),
            ),
          )
        }
        left_record = match parse_decision_id(left_id, "left", csv_record) {
          Ok(value) => Some(value)
          Err(error) => return Err(error)
        }
      }
      "right_unmatched" => {
        if right_id == "" || left_id != "" {
          return Err(
            decision_error(
              "invalid_decision",
              "right_unmatched requires only right_id",
              Some(csv_record),
            ),
          )
        }
        right_record = match parse_decision_id(right_id, "right", csv_record) {
          Ok(value) => Some(value)
          Err(error) => return Err(error)
        }
      }
      _ =>
        return Err(
          decision_error(
            "invalid_decision_action",
            "unknown decision action '\{action}'",
            Some(csv_record),
          ),
        )
    }
    decisions.push({
      action,
      left_record,
      right_record,
      reason,
      csv_record,
      is_override: false,
    })
  }
  Ok(decisions)
}

///|
fn decision_to_json(decision : Decision) -> Json {
  Json::object({
    "action": Json::string(decision.action),
    "left_id": match decision.left_record {
      Some(value) => Json::string(result_record_id("left", value))
      None => Json::null()
    },
    "right_id": match decision.right_record {
      Some(value) => Json::string(result_record_id("right", value))
      None => Json::null()
    },
    "reason": Json::string(decision.reason),
    "override": Json::boolean(decision.is_override),
  })
}

///|
fn decision_same(left : Decision, right : Decision) -> Bool {
  left.action == right.action &&
  left.left_record == right.left_record &&
  left.right_record == right.right_record &&
  left.reason == right.reason
}

///|
fn decision_identity(left : Decision, right : Decision) -> Bool {
  left.action == right.action &&
  left.left_record == right.left_record &&
  left.right_record == right.right_record
}

///|
fn decision_threshold(config : Config) -> Int? {
  match json_object(Some(config.candidates)) {
    Some(specs) =>
      match parse_int_json(specs.get("threshold"), "threshold") {
        Ok(value) => Some(value)
        Err(_) => None
      }
    None => None
  }
}

///|
fn threshold_candidate(
  base : ReconciliationResult,
  decision : Decision,
  threshold : Int?,
) -> Bool {
  let left_id = result_record_id("left", decision.left_record.unwrap())
  let right_id = result_record_id("right", decision.right_record.unwrap())
  for candidate in base.candidates {
    match json_object(Some(candidate)) {
      Some(fields) if fields.get("left_id") == Some(Json::string(left_id)) &&
        fields.get("right_id") == Some(Json::string(right_id)) =>
        match (fields.get("score"), threshold) {
          (Some(Json::Number(score, ..)), Some(minimum)) =>
            return score >= minimum.to_double()
          _ => return false
        }
      _ => ()
    }
  }
  false
}

///|
fn record_exists(record : Int?, total : Int) -> Bool {
  match record {
    Some(value) => value > 0 && value <= total
    None => false
  }
}

///|
fn record_is_exact(
  base : ReconciliationResult,
  left_record : Int?,
  right_record : Int?,
) -> Bool {
  for pair in base.pairs {
    if pair.source == "exact_key" &&
      (
        left_record == Some(pair.left_record) ||
        right_record == Some(pair.right_record)
      ) {
      return true
    }
  }
  false
}

///|
fn record_key(record : Int?) -> String {
  match record {
    Some(value) => value.to_string()
    None => "-"
  }
}

///|
fn pair_key(left_record : Int?, right_record : Int?) -> String {
  "\{record_key(left_record)}#\{record_key(right_record)}"
}

///|
fn decision_less(left : Decision, right : Decision) -> Bool {
  let ll = left.left_record.unwrap_or(0)
  let rl = right.left_record.unwrap_or(0)
  if ll != rl {
    return ll < rl
  }
  let lr = left.right_record.unwrap_or(0)
  let rr = right.right_record.unwrap_or(0)
  if lr != rr {
    return lr < rr
  }
  if left.action != right.action {
    return left.action < right.action
  }
  left.reason < right.reason
}

///|
fn sort_decisions(values : Array[Decision]) -> Array[Decision] {
  let sorted = values.copy()
  for i in 0..<sorted.length() {
    for j in 0..<(sorted.length() - i - 1) {
      if decision_less(sorted[j + 1], sorted[j]) {
        let item = sorted[j]
        sorted[j] = sorted[j + 1]
        sorted[j + 1] = item
      }
    }
  }
  sorted
}

///|
pub fn apply_decisions(
  base : ReconciliationResult,
  decisions : Array[Decision],
  left : Table,
  right : Table,
  config : Config,
) -> Result[ReconciliationResult, EngineError] {
  let accepted : Array[Decision] = []
  let rejects : Array[Decision] = []
  let unmatched_left_decisions : Array[Decision] = []
  let unmatched_right_decisions : Array[Decision] = []
  let unique : Array[Decision] = []
  let threshold = decision_threshold(config)
  for item in decisions {
    let exists = match item.action {
      "accept" | "reject" =>
        record_exists(item.left_record, left.rows.length()) &&
        record_exists(item.right_record, right.rows.length())
      "left_unmatched" =>
        record_exists(item.left_record, left.rows.length()) &&
        item.right_record is None
      "right_unmatched" =>
        record_exists(item.right_record, right.rows.length()) &&
        item.left_record is None
      _ => false
    }
    if !exists {
      return Err(
        decision_error(
          "invalid_decision",
          "decision has an invalid action shape or references a nonexistent record",
          Some(item.csv_record),
        ),
      )
    }
    if record_is_exact(base, item.left_record, item.right_record) {
      return Err(
        decision_error(
          "locked_exact_pair",
          "exact-key paired endpoints cannot be changed by review decisions",
          Some(item.csv_record),
        ),
      )
    }
    let mut duplicate = false
    for previous in unique {
      if decision_same(previous, item) {
        duplicate = true
      } else if decision_identity(previous, item) {
        return Err(
          decision_error(
            "conflicting_decisions",
            "the same action and endpoints have different reasons",
            Some(item.csv_record),
          ),
        )
      }
    }
    if !duplicate {
      unique.push(item)
    }
  }
  for item in unique {
    match item.action {
      "accept" => {
        if !threshold_candidate(base, item, threshold) &&
          ascii_trim(item.reason).is_empty() {
          return Err(
            decision_error(
              "manual_override_needs_reason",
              "accepting a pair without a threshold-qualified score requires a nonblank reason",
              Some(item.csv_record),
            ),
          )
        }
        for other in unique {
          if other.action == "accept" &&
            !decision_same(item, other) &&
            (
              item.left_record == other.left_record ||
              item.right_record == other.right_record
            ) {
            return Err(
              decision_error(
                "conflicting_decisions",
                "accepted pairs cannot share a record endpoint",
                Some(other.csv_record),
              ),
            )
          }
          if other.action == "reject" &&
            pair_key(item.left_record, item.right_record) ==
            pair_key(other.left_record, other.right_record) {
            return Err(
              decision_error(
                "conflicting_decisions",
                "the same pair cannot be both accepted and rejected",
                Some(other.csv_record),
              ),
            )
          }
          if (
              other.action == "left_unmatched" &&
              item.left_record == other.left_record
            ) ||
            (
              other.action == "right_unmatched" &&
              item.right_record == other.right_record
            ) {
            return Err(
              decision_error(
                "conflicting_decisions",
                "an accepted endpoint cannot also be confirmed unmatched",
                Some(other.csv_record),
              ),
            )
          }
        }
        accepted.push(item)
      }
      "reject" => rejects.push(item)
      "left_unmatched" => unmatched_left_decisions.push(item)
      "right_unmatched" => unmatched_right_decisions.push(item)
      _ =>
        return Err(
          decision_error(
            "invalid_decision_action",
            "unknown decision action",
            Some(item.csv_record),
          ),
        )
    }
  }

  let pairs = base.pairs.copy()
  for item in accepted {
    let left_record = item.left_record.unwrap()
    let right_record = item.right_record.unwrap()
    let comparisons : Array[FieldComparison] = []
    for field in config.fields {
      if field.compare {
        let left_column = header_index(left, field.left).unwrap()
        let right_column = header_index(right, field.right).unwrap()
        comparisons.push(
          compare_field(
            left.rows[left_record - 1][left_column],
            right.rows[right_record - 1][right_column],
            field,
          ),
        )
      }
    }
    pairs.push({
      left_record,
      right_record,
      source: "human_review",
      reason: item.reason,
      is_override: !threshold_candidate(base, item, threshold),
      fields: comparisons,
    })
  }
  pairs.sort_by(fn(a, b) {
    if a.left_record != b.left_record {
      a.left_record - b.left_record
    } else {
      a.right_record - b.right_record
    }
  })
  let unmatched_left = base.unmatched_left_records.copy()
  let unmatched_right = base.unmatched_right_records.copy()
  for item in unmatched_left_decisions {
    unmatched_left.push(item.left_record.unwrap())
  }
  for item in unmatched_right_decisions {
    unmatched_right.push(item.right_record.unwrap())
  }
  unmatched_left.sort()
  unmatched_right.sort()

  let pending_left_records = base.pending_left_records.filter(fn(record) {
    !accepted.any(fn(item) { item.left_record == Some(record) }) &&
    !unmatched_left_decisions.any(fn(item) { item.left_record == Some(record) })
  })
  let pending_right_records = base.pending_right_records.filter(fn(record) {
    !accepted.any(fn(item) { item.right_record == Some(record) }) &&
    !unmatched_right_decisions.any(fn(item) {
      item.right_record == Some(record)
    })
  })
  let unprocessed_left = base.unprocessed_left_records.filter(fn(record) {
    !accepted.any(fn(item) { item.left_record == Some(record) }) &&
    !unmatched_left_decisions.any(fn(item) { item.left_record == Some(record) })
  })
  let unprocessed_right = base.unprocessed_right_records.filter(fn(record) {
    !accepted.any(fn(item) { item.right_record == Some(record) }) &&
    !unmatched_right_decisions.any(fn(item) {
      item.right_record == Some(record)
    })
  })
  let candidates = base.candidates.map(fn(candidate) {
    match json_object(Some(candidate)) {
      Some(fields) => {
        let left_id = json_string(fields.get("left_id")).unwrap_or("")
        let right_id = json_string(fields.get("right_id")).unwrap_or("")
        let disposed = accepted.any(fn(item) {
            item.left_record == Some(record_id_num(left_id)) ||
            item.right_record == Some(record_id_num(right_id))
          }) ||
          unmatched_left_decisions.any(fn(item) {
            item.left_record == Some(record_id_num(left_id))
          }) ||
          unmatched_right_decisions.any(fn(item) {
            item.right_record == Some(record_id_num(right_id))
          }) ||
          rejects.any(fn(item) {
            item.left_record == Some(record_id_num(left_id)) &&
            item.right_record == Some(record_id_num(right_id))
          })
        if disposed {
          let copy = fields.copy()
          copy["suggested"] = Json::boolean(false)
          Json::object(copy)
        } else {
          candidate
        }
      }
      None => candidate
    }
  })
  let has_field_issue = pairs.any(fn(pair) {
    pair.fields.any(fn(field) {
      field.status == "different" || field.status == "invalid_value"
    })
  })
  let has_key_error = base.diagnostics.any(fn(issue) {
    match issue_code(issue) {
      Some("duplicate_key") | Some("invalid_or_missing_key") => true
      _ => false
    }
  })
  let pending_left = pending_left_records.length() - unprocessed_left.length()
  let pending_right = pending_right_records.length() -
    unprocessed_right.length()
  let exit_code = if base.status == "incomplete" {
    3
  } else if pending_left > 0 ||
    pending_right > 0 ||
    !unmatched_left.is_empty() ||
    !unmatched_right.is_empty() ||
    has_field_issue ||
    has_key_error ||
    !base.unmapped_left.is_empty() ||
    !base.unmapped_right.is_empty() {
    1
  } else {
    0
  }
  Ok({
    status: base.status,
    exit_code,
    left_total: base.left_total,
    right_total: base.right_total,
    pairs,
    pending_left,
    pending_right,
    pending_left_records,
    pending_right_records,
    diagnostics: base.diagnostics.copy(),
    candidates,
    computation_issues: base.computation_issues.copy(),
    unprocessed_left_records: unprocessed_left,
    unprocessed_right_records: unprocessed_right,
    unmatched_left_records: unmatched_left,
    unmatched_right_records: unmatched_right,
    decisions: sort_decisions(
      unique.map(fn(item) {
        {
          ..item,
          is_override: item.action == "accept" &&
          !threshold_candidate(base, item, threshold),
        }
      }),
    ),
    unmapped_left: base.unmapped_left.copy(),
    unmapped_right: base.unmapped_right.copy(),
    ignored_left: base.ignored_left.copy(),
    ignored_right: base.ignored_right.copy(),
    fatal_error: base.fatal_error,
  })
}

///|
fn record_id_num(id : String) -> Int {
  let chars = id.to_array()
  if chars.length() < 2 {
    return 0
  }
  let mut result = 0
  for char in chars[1:] {
    if char < '0' || char > '9' {
      return 0
    }
    result = result * 10 + char.to_int() - '0'.to_int()
  }
  result
}
