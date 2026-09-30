///|
fn optional_string_json(value : String?) -> Json {
  match value {
    Some(text) => Json::string(text)
    None => Json::null()
  }
}

///|
fn result_record_id(side : String, record : Int) -> String {
  let prefix = if side == "left" { "L" } else { "R" }
  "\{prefix}\{record}"
}

///|
fn record_entry(
  side : String,
  record : Int,
  paired : Bool,
  unprocessed : Bool,
) -> Json {
  Json::object({
    "id": Json::string(result_record_id(side, record)),
    "side": Json::string(side),
    "record": Json::number(record.to_double()),
    "status": Json::string(
      if paired {
        "paired"
      } else if unprocessed {
        "unprocessed"
      } else {
        "pending_review"
      },
    ),
    "reason": Json::string(
      if paired {
        "exact_key"
      } else if unprocessed {
        "computation_incomplete"
      } else {
        "review_required"
      },
    ),
  })
}

///|
fn comparison_to_json(pair : ExactPair, field : FieldComparison) -> Json {
  Json::object({
    "left_id": Json::string(result_record_id("left", pair.left_record)),
    "right_id": Json::string(result_record_id("right", pair.right_record)),
    "field": Json::string(field.field),
    "type": Json::string(field.field_type),
    "left_raw": Json::string(field.left_raw),
    "right_raw": Json::string(field.right_raw),
    "left_transformed": Json::string(field.left_transformed),
    "right_transformed": Json::string(field.right_transformed),
    "left_canonical": optional_string_json(field.left_canonical),
    "right_canonical": optional_string_json(field.right_canonical),
    "status": Json::string(field.status),
    "rules": Json::array(field.rules.map(Json::string)),
    "difference": optional_string_json(field.difference),
    "tolerance": optional_string_json(field.tolerance),
    "explanation": Json::string(field.explanation),
  })
}

///|
fn pair_to_json(pair : ExactPair) -> Json {
  Json::object({
    "left_id": Json::string(result_record_id("left", pair.left_record)),
    "right_id": Json::string(result_record_id("right", pair.right_record)),
    "source": Json::string(pair.source),
    "reason": Json::string(pair.reason),
    "override": Json::boolean(pair.is_override),
  })
}

///|
fn side_summary(
  total : Int,
  paired : Int,
  pending : Int,
  unprocessed : Int,
) -> Json {
  Json::object({
    "total": Json::number(total.to_double()),
    "paired": Json::number(paired.to_double()),
    "unmatched": Json::number(0.0),
    "pending_review": Json::number(pending.to_double()),
    "unprocessed": Json::number(unprocessed.to_double()),
  })
}

///|
fn is_key_issue(issue : Json) -> Bool {
  match issue {
    Json::Object(details) =>
      match details.get("code") {
        Some(Json::String("duplicate_key")) => true
        Some(Json::String("invalid_or_missing_key")) => true
        Some(Json::String("key_not_found")) => true
        Some(Json::String("no_key_configured")) => true
        _ => false
      }
    _ => false
  }
}

///|
fn issue_code(issue : Json) -> String? {
  match issue {
    Json::Object(details) =>
      match details.get("code") {
        Some(Json::String(code)) => Some(code)
        _ => None
      }
    _ => None
  }
}

///|
pub fn result_to_json(result : ReconciliationResult) -> Json {
  let records : Array[Json] = []
  let paired_left = Array::make(result.left_total, false)
  let paired_right = Array::make(result.right_total, false)
  let unprocessed_left = Array::make(result.left_total, false)
  let unprocessed_right = Array::make(result.right_total, false)
  for record in result.unprocessed_left_records {
    unprocessed_left[record - 1] = true
  }
  for record in result.unprocessed_right_records {
    unprocessed_right[record - 1] = true
  }
  for pair in result.pairs {
    paired_left[pair.left_record - 1] = true
    paired_right[pair.right_record - 1] = true
  }
  for index in 0..<result.left_total {
    records.push(
      record_entry(
        "left",
        index + 1,
        paired_left[index],
        unprocessed_left[index],
      ),
    )
  }
  for index in 0..<result.right_total {
    records.push(
      record_entry(
        "right",
        index + 1,
        paired_right[index],
        unprocessed_right[index],
      ),
    )
  }

  let pairs = result.pairs.map(pair_to_json)
  let fields : Array[Json] = []
  let field_equal = Ref(0)
  let field_equivalent = Ref(0)
  let field_different = Ref(0)
  let field_invalid = Ref(0)
  for pair in result.pairs {
    for field in pair.fields {
      fields.push(comparison_to_json(pair, field))
      match field.status {
        "equal" => field_equal.val += 1
        "equivalent_by_rule" => field_equivalent.val += 1
        "different" => field_different.val += 1
        "invalid_value" => field_invalid.val += 1
        _ => ()
      }
    }
  }

  let key_issues : Array[Json] = []
  for issue in result.diagnostics {
    if is_key_issue(issue) {
      key_issues.push(issue)
    }
  }
  let structural_issue_count = Ref(0)
  for issue in result.diagnostics {
    match issue_code(issue) {
      Some("unmapped_column") => structural_issue_count.val += 1
      Some("missing_ignored_column") => structural_issue_count.val += 1
      Some("missing_mandatory_column") => structural_issue_count.val += 1
      _ => ()
    }
  }
  let unresolved_count = result.pending_left +
    result.pending_right +
    result.unprocessed_left_records.length() +
    result.unprocessed_right_records.length()
  Json::object({
    "schema_version": Json::number(1.0),
    "engine_version": Json::string("0.1.0"),
    "computation": Json::object({
      "status": Json::string(result.status),
      "issues": Json::array(result.computation_issues),
    }),
    "records": Json::array(records),
    "pairs": Json::array(pairs),
    "fields": Json::array(fields),
    "candidates": Json::array(result.candidates),
    "decisions": Json::array([]),
    "structure": Json::object({
      "unmapped_left": Json::array(result.unmapped_left.map(Json::string)),
      "unmapped_right": Json::array(result.unmapped_right.map(Json::string)),
      "ignored_left": Json::array(result.ignored_left.map(Json::string)),
      "ignored_right": Json::array(result.ignored_right.map(Json::string)),
    }),
    "key_issues": Json::array(key_issues),
    "summary": Json::object({
      "per_side": Json::object({
        "left": side_summary(
          result.left_total,
          result.pairs.length(),
          result.pending_left,
          result.unprocessed_left_records.length(),
        ),
        "right": side_summary(
          result.right_total,
          result.pairs.length(),
          result.pending_right,
          result.unprocessed_right_records.length(),
        ),
      }),
      "fields": Json::object({
        "equal": Json::number(field_equal.val.to_double()),
        "equivalent_by_rule": Json::number(field_equivalent.val.to_double()),
        "different": Json::number(field_different.val.to_double()),
        "invalid_value": Json::number(field_invalid.val.to_double()),
      }),
      "structural_issue_count": Json::number(
        structural_issue_count.val.to_double(),
      ),
      "key_issue_count": Json::number(key_issues.length().to_double()),
      "candidate_count": Json::number(result.candidates.length().to_double()),
      "unresolved_count": Json::number(unresolved_count.to_double()),
    }),
    "exit_code": Json::number(result.exit_code.to_double()),
  })
}
