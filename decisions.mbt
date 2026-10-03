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
// Canonical CSV wire size: UTF-8 payload, doubled quotes, conditional enclosing
// quotes. Row commas/LF and the header are counted by the caller.
fn decision_csv_cell_bytes(value : String) -> Int {
  let mut bytes = 0
  let mut quoted = false
  for ch in value {
    bytes += utf8_char_size(ch)
    if ch == '"' {
      bytes += 1
    }
    if ch == '"' || ch == ',' || ch == '\r' || ch == '\n' {
      quoted = true
    }
  }
  bytes + (if quoted { 2 } else { 0 })
}

///|
pub fn parse_decisions(csv : String) -> Result[Array[Decision], EngineError] {
  parse_decisions_with_budget(csv, 134217728, 400000, 67108864, 100000)
}

///|
fn parse_decisions_with_budget(
  csv : String,
  max_raw_bytes : Int,
  max_raw_rows : Int,
  max_active_bytes : Int,
  max_active_rows : Int,
) -> Result[Array[Decision], EngineError] {
  let table = match
    parse_csv_with_budget(csv, "decisions", max_raw_bytes, max_raw_rows) {
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
  let mut active_bytes = 31 // action,left_id,right_id,reason plus LF
  if active_bytes > max_active_bytes {
    return Err(
      decision_error(
        "decision_limit_exceeded",
        "canonical active decision CSV exceeds the \{max_active_bytes}-byte limit",
        None,
      ),
    )
  }
  for row_index in 0..<table.rows.length() {
    let row = table.rows[row_index]
    let action = row[0]
    if action == "" {
      continue
    }
    let csv_record = row_index + 1
    if decisions.length() >= max_active_rows {
      return Err(
        decision_error(
          "decision_limit_exceeded",
          "decision CSV exceeds the \{max_active_rows} nonblank-action row limit before deduplication",
          Some(csv_record),
        ),
      )
    }
    // Each accepted cell is already capped at 64 KiB. Check each addition
    // against the remaining budget, keeping all arithmetic bounded.
    let mut row_bytes = 4 // three commas and LF
    for cell in row {
      row_bytes += decision_csv_cell_bytes(cell)
    }
    if row_bytes > max_active_bytes - active_bytes {
      return Err(
        decision_error(
          "decision_limit_exceeded",
          "canonical active decision CSV exceeds the \{max_active_bytes}-byte limit",
          Some(csv_record),
        ),
      )
    }
    active_bytes += row_bytes
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
fn qualified_review_pairs(
  base : ReconciliationResult,
  threshold : Int?,
) -> Map[String, Bool] {
  let index : Map[String, Bool] = Map([])
  for candidate in base.candidates {
    match json_object(Some(candidate)) {
      Some(fields) =>
        match
          (
            json_string(fields.get("left_id")),
            json_string(fields.get("right_id")),
          ) {
          (Some(left_id), Some(right_id)) => {
            let key = left_id + "#" + right_id
            if !index.contains(key) {
              index[key] = match (fields.get("score"), threshold) {
                (Some(Json::Number(score, ..)), Some(minimum)) =>
                  score >= minimum.to_double()
                _ => false
              }
            }
          }
          _ => ()
        }
      None => ()
    }
  }
  index
}

///|
fn review_pair_qualified(
  index : Map[String, Bool],
  decision : Decision,
) -> Bool {
  match (decision.left_record, decision.right_record) {
    (Some(left), Some(right)) =>
      index.get("L\{left}#R\{right}").unwrap_or(false)
    _ => false
  }
}

///|
fn record_exists(record : Int?, total : Int) -> Bool {
  match record {
    Some(value) => value > 0 && value <= total
    None => false
  }
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
  sorted.sort_by(fn(a, b) {
    if decision_less(a, b) {
      -1
    } else if decision_less(b, a) {
      1
    } else {
      0
    }
  })
  sorted
}

///|
fn review_accept_index_add(
  index : Map[Int, Array[Int]],
  record : Int,
  position : Int,
) -> Unit {
  match index.get(record) {
    Some(positions) => if positions.length() < 2 { positions.push(position) }
    None => index[record] = [position]
  }
}

///|
fn review_other_accept(
  index : Map[Int, Array[Int]],
  record : Int,
  position : Int,
  absent : Int,
) -> Int {
  match index.get(record) {
    Some(positions) =>
      if positions[0] != position {
        positions[0]
      } else if positions.length() > 1 {
        positions[1]
      } else {
        absent
      }
    None => absent
  }
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
  let qualified = qualified_review_pairs(base, decision_threshold(config))
  let exact_left : Map[Int, Bool] = Map([])
  let exact_right : Map[Int, Bool] = Map([])
  for pair in base.pairs {
    if pair.source == "exact_key" {
      exact_left[pair.left_record] = true
      exact_right[pair.right_record] = true
    }
  }
  let seen : Map[String, Decision] = Map([])
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
    let locked = (match item.left_record {
        Some(record) => exact_left.contains(record)
        None => false
      }) ||
      (match item.right_record {
        Some(record) => exact_right.contains(record)
        None => false
      })
    if locked {
      return Err(
        decision_error(
          "locked_exact_pair",
          "exact-key paired endpoints cannot be changed by review decisions",
          Some(item.csv_record),
        ),
      )
    }
    let identity = item.action +
      "#" +
      pair_key(item.left_record, item.right_record)
    match seen.get(identity) {
      Some(previous) =>
        if previous.reason != item.reason {
          return Err(
            decision_error(
              "conflicting_decisions",
              "the same action and endpoints have different reasons",
              Some(item.csv_record),
            ),
          )
        }
      None => {
        seen[identity] = item
        unique.push(item)
      }
    }
  }
  // Keep the original input-order error priority. For each acceptance, the
  // earliest conflicting *other* row wins across all conflict categories.
  let accept_left : Map[Int, Array[Int]] = Map([])
  let accept_right : Map[Int, Array[Int]] = Map([])
  let reject_pairs : Map[String, Int] = Map([])
  let left_unmatched : Map[Int, Int] = Map([])
  let right_unmatched : Map[Int, Int] = Map([])
  for position in 0..<unique.length() {
    let item = unique[position]
    match item.action {
      "accept" => {
        review_accept_index_add(
          accept_left,
          item.left_record.unwrap(),
          position,
        )
        review_accept_index_add(
          accept_right,
          item.right_record.unwrap(),
          position,
        )
      }
      "reject" =>
        reject_pairs[pair_key(item.left_record, item.right_record)] = position
      "left_unmatched" => left_unmatched[item.left_record.unwrap()] = position
      "right_unmatched" =>
        right_unmatched[item.right_record.unwrap()] = position
      _ => ()
    }
  }
  for position in 0..<unique.length() {
    let item = unique[position]
    match item.action {
      "accept" => {
        if !review_pair_qualified(qualified, item) &&
          ascii_trim(item.reason).is_empty() {
          return Err(
            decision_error(
              "manual_override_needs_reason",
              "accepting a pair without a threshold-qualified score requires a nonblank reason",
              Some(item.csv_record),
            ),
          )
        }
        let absent = unique.length()
        let mut conflict = absent
        let mut message = ""
        for
          other in [
            review_other_accept(
              accept_left,
              item.left_record.unwrap(),
              position,
              absent,
            ),
            review_other_accept(
              accept_right,
              item.right_record.unwrap(),
              position,
              absent,
            ),
          ] {
          if other < conflict {
            conflict = other
            message = "accepted pairs cannot share a record endpoint"
          }
        }
        let rejected = reject_pairs
          .get(pair_key(item.left_record, item.right_record))
          .unwrap_or(absent)
        if rejected < conflict {
          conflict = rejected
          message = "the same pair cannot be both accepted and rejected"
        }
        for
          other in [
            left_unmatched.get(item.left_record.unwrap()).unwrap_or(absent),
            right_unmatched.get(item.right_record.unwrap()).unwrap_or(absent),
          ] {
          if other < conflict {
            conflict = other
            message = "an accepted endpoint cannot also be confirmed unmatched"
          }
        }
        if conflict < absent {
          return Err(
            decision_error(
              "conflicting_decisions",
              message,
              Some(unique[conflict].csv_record),
            ),
          )
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
      is_override: !review_pair_qualified(qualified, item),
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

  let disposed_left : Map[Int, Bool] = Map([])
  let disposed_right : Map[Int, Bool] = Map([])
  for item in accepted {
    disposed_left[item.left_record.unwrap()] = true
    disposed_right[item.right_record.unwrap()] = true
  }
  for item in unmatched_left_decisions {
    disposed_left[item.left_record.unwrap()] = true
  }
  for item in unmatched_right_decisions {
    disposed_right[item.right_record.unwrap()] = true
  }
  let rejected_pairs : Map[String, Bool] = Map([])
  for item in rejects {
    rejected_pairs[pair_key(item.left_record, item.right_record)] = true
  }
  let pending_left_records = base.pending_left_records.filter(fn(record) {
    !disposed_left.contains(record)
  })
  let pending_right_records = base.pending_right_records.filter(fn(record) {
    !disposed_right.contains(record)
  })
  let unprocessed_left = base.unprocessed_left_records.filter(fn(record) {
    !disposed_left.contains(record)
  })
  let unprocessed_right = base.unprocessed_right_records.filter(fn(record) {
    !disposed_right.contains(record)
  })
  let candidates = base.candidates.map(fn(candidate) {
    match json_object(Some(candidate)) {
      Some(fields) => {
        let left_record = record_id_num(
          json_string(fields.get("left_id")).unwrap_or(""),
        )
        let right_record = record_id_num(
          json_string(fields.get("right_id")).unwrap_or(""),
        )
        if disposed_left.contains(left_record) ||
          disposed_right.contains(right_record) ||
          rejected_pairs.contains(
            pair_key(Some(left_record), Some(right_record)),
          ) {
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
          !review_pair_qualified(qualified, item),
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
