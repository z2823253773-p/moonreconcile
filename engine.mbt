///|
fn request_error(
  code : String,
  message : String,
  field : String?,
) -> EngineError {
  match field {
    Some(value) => engine_error(code, message, "request", field=value)
    None => engine_error(code, message, "request")
  }
}

///|
fn parse_request(request_json : String) -> Json? {
  Some(@json.parse(request_json)) catch {
    _ => None
  }
}

///|
fn require_request_string(
  object : Map[String, Json],
  key : String,
) -> Result[String, EngineError] {
  match object.get(key) {
    Some(Json::String(value)) => Ok(value)
    _ =>
      Err(
        request_error(
          "invalid_request",
          "request property '\{key}' must be a string",
          Some(key),
        ),
      )
  }
}

///|
fn draft_field(name : String, left : Json, right : Json) -> Json {
  Json::object({
    "name": Json::string(name),
    "left": left,
    "right": right,
    "type": Json::null(),
    "compare": Json::boolean(true),
    "trim_ascii": Json::boolean(false),
    "lower_ascii": Json::boolean(false),
    "left_values": Json::empty_object(),
    "right_values": Json::empty_object(),
    "missing": Json::array([]),
    "both_missing": Json::string("equal"),
    "abs_tol": Json::string("0"),
    "rel_tol": Json::string("0"),
    "days_tol": Json::number(0.0),
  })
}

///|
/// Builds a draft template. Mapping is suggested only where header names agree
/// exactly; no field type, key, transform or missing marker is inferred.
fn build_draft_config(left : CsvTable, right : CsvTable) -> Json {
  let fields : Array[Json] = []
  for header in left.headers {
    let right_source = if right.headers.contains(header) {
      Json::string(header)
    } else {
      Json::null()
    }
    fields.push(draft_field(header, Json::string(header), right_source))
  }
  for header in right.headers {
    if !left.headers.contains(header) {
      fields.push(draft_field(header, Json::null(), Json::string(header)))
    }
  }
  Json::object({
    "schema_version": Json::number(1.0),
    "draft": Json::boolean(true),
    "fields": Json::array(fields),
    "key": Json::array([]),
    "ignore_left": Json::array([]),
    "ignore_right": Json::array([]),
    "candidates": Json::null(),
  })
}

///|
fn handle_init_config(object : Map[String, Json]) -> Json {
  let left_csv = match require_request_string(object, "left_csv") {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  let right_csv = match require_request_string(object, "right_csv") {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  let left = match parse_csv(left_csv, "left") {
    Ok(table) => table
    Err(error) => return error_to_json(error)
  }
  let right = match parse_csv(right_csv, "right") {
    Ok(table) => table
    Err(error) => return error_to_json(error)
  }
  success_to_json("config", build_draft_config(left, right))
}

///|
fn handle_check_config(object : Map[String, Json]) -> Json {
  let config_json = match object.get("config") {
    Some(value) => value
    None =>
      return error_to_json(
        request_error(
          "invalid_request",
          "operation 'check_config' requires a config object",
          Some("config"),
        ),
      )
  }
  match parse_config(config_json) {
    Ok(config) => success_to_json("config", normalize_config(config))
    Err(error) => error_to_json(error)
  }
}

///|
fn handle_compare(object : Map[String, Json]) -> Json {
  let left_csv = match require_request_string(object, "left_csv") {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  let right_csv = match require_request_string(object, "right_csv") {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  let left = match parse_csv(left_csv, "left") {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  let right = match parse_csv(right_csv, "right") {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  let config_json = match object.get("config") {
    Some(value) => value
    None =>
      return error_to_json(
        request_error(
          "invalid_request",
          "operation 'compare' requires a config object",
          Some("config"),
        ),
      )
  }
  let config = match parse_config(config_json) {
    Ok(value) => value
    Err(error) => return error_to_json(error)
  }
  let result = compare_tables(left, right, config)
  match result.fatal_error {
    Some(error) =>
      return Json::object({
        "ok": Json::boolean(false),
        "error": error_details_to_json(error),
        "result": result_to_json(result),
      })
    None => ()
  }
  if result.pending_left > 0 || result.pending_right > 0 {
    if config.candidates is Json::Object(_) {
      return error_to_json(
        request_error(
          "candidate_stage_not_implemented",
          "candidate processing is not available in this engine milestone; exact results are not being reported as complete",
          Some("candidates"),
        ),
      )
    }
  }
  success_to_json("result", result_to_json(result))
}

///|
fn unsupported_operation(op : String) -> Json {
  error_to_json(
    request_error(
      "unsupported_operation",
      "operation '\{op}' is not implemented yet",
      Some("op"),
    ),
  )
}

///|
fn handle_request(request_json : String) -> Json {
  let parsed = match parse_request(request_json) {
    Some(value) => value
    None =>
      return error_to_json(
        request_error("invalid_json", "request is not valid JSON", None),
      )
  }
  let object = match parsed {
    Json::Object(fields) => fields
    _ =>
      return error_to_json(
        request_error("invalid_json", "request must be a JSON object", None),
      )
  }
  let op = match object.get("op") {
    Some(Json::String(value)) => value
    _ =>
      return error_to_json(
        request_error(
          "invalid_request",
          "request property 'op' must be a string",
          Some("op"),
        ),
      )
  }
  match op {
    "init_config" => handle_init_config(object)
    "check_config" => handle_check_config(object)
    "compare" => handle_compare(object)
    "resolve" => unsupported_operation(op)
    _ =>
      error_to_json(
        request_error(
          "unknown_operation",
          "unknown operation: \{op}",
          Some("op"),
        ),
      )
  }
}

///|
/// The single Node-facing entry point. Pure JSON in, pure JSON out; the engine
/// never touches the filesystem and never terminates the host process.
pub fn invoke(request_json : String) -> String {
  handle_request(request_json).stringify()
}
