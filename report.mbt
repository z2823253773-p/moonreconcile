///|
fn optional_string_json(value : String?) -> Json {
  match value {
    Some(text) => Json::string(text)
    None => Json::null()
  }
}

///|
fn comparison_to_json(field : FieldComparison) -> Json {
  Json::object({
    "field": Json::string(field.field),
    "type": Json::string(field.field_type),
    "left_raw": Json::string(field.left_raw),
    "right_raw": Json::string(field.right_raw),
    "left_transformed": Json::string(field.left_transformed),
    "right_transformed": Json::string(field.right_transformed),
    "left_canonical": optional_string_json(field.left_canonical),
    "right_canonical": optional_string_json(field.right_canonical),
    "left_missing": Json::boolean(field.left_missing),
    "right_missing": Json::boolean(field.right_missing),
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
    "left_record": Json::number(pair.left_record.to_double()),
    "right_record": Json::number(pair.right_record.to_double()),
    "source": Json::string("exact_key"),
    "status": Json::string("paired"),
    "fields": Json::array(pair.fields.map(comparison_to_json)),
  })
}

///|
pub fn result_to_json(result : ReconciliationResult) -> Json {
  let field_issue_count = Ref(0)
  for pair in result.pairs {
    for field in pair.fields {
      if field.status == "different" || field.status == "invalid_value" {
        field_issue_count.val += 1
      }
    }
  }
  let fatal = match result.fatal_error {
    Some(error) =>
      Json::object({
        "code": Json::string(error.code),
        "message": Json::string(error.message),
        "phase": Json::string(error.phase),
      })
    None => Json::null()
  }
  Json::object({
    "schema_version": Json::number(1.0),
    "run_status": Json::string(result.status),
    "exit_code": Json::number(result.exit_code.to_double()),
    "pairs": Json::array(result.pairs.map(pair_to_json)),
    "records": Json::object({
      "left": Json::object({
        "total": Json::number(result.left_total.to_double()),
        "paired": Json::number(result.pairs.length().to_double()),
        "unmatched": Json::number(0.0),
        "pending_review": Json::number(result.pending_left.to_double()),
        "unprocessed": Json::number(0.0),
        "pending_records": Json::array(
          result.pending_left_records.map(fn(record) {
            Json::number(record.to_double())
          }),
        ),
      }),
      "right": Json::object({
        "total": Json::number(result.right_total.to_double()),
        "paired": Json::number(result.pairs.length().to_double()),
        "unmatched": Json::number(0.0),
        "pending_review": Json::number(result.pending_right.to_double()),
        "unprocessed": Json::number(0.0),
        "pending_records": Json::array(
          result.pending_right_records.map(fn(record) {
            Json::number(record.to_double())
          }),
        ),
      }),
    }),
    "field_issue_count": Json::number(field_issue_count.val.to_double()),
    "structure": Json::object({
      "unmapped_left": Json::array(result.unmapped_left.map(Json::string)),
      "unmapped_right": Json::array(result.unmapped_right.map(Json::string)),
      "ignored_left": Json::array(result.ignored_left.map(Json::string)),
      "ignored_right": Json::array(result.ignored_right.map(Json::string)),
    }),
    "diagnostics": Json::array(result.diagnostics),
    "fatal_error": fatal,
    "candidates": Json::array([]),
    "decisions": Json::array([]),
  })
}
