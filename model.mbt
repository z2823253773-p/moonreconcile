///|
pub(all) struct EngineError {
  code : String
  message : String
  phase : String
  side : Json
  record : Json
  field : Json
}

///|
pub(all) struct CsvTable {
  headers : Array[String]
  rows : Array[Array[String]]
}

///|
pub type Table = CsvTable

///|
pub(all) struct ExactPair {
  left_record : Int
  right_record : Int
  source : String
  reason : String
  is_override : Bool
  fields : Array[FieldComparison]
}

///|
pub(all) struct ReconciliationResult {
  status : String
  exit_code : Int
  left_total : Int
  right_total : Int
  pairs : Array[ExactPair]
  pending_left : Int
  pending_right : Int
  pending_left_records : Array[Int]
  pending_right_records : Array[Int]
  diagnostics : Array[Json]
  unmapped_left : Array[String]
  unmapped_right : Array[String]
  ignored_left : Array[String]
  ignored_right : Array[String]
  fatal_error : EngineError?
}

///|
pub(all) struct FieldConfig {
  name : String
  left : String
  right : String
  field_type : String
  compare : Bool
  trim_ascii : Bool
  lower_ascii : Bool
  left_values : Map[String, String]
  right_values : Map[String, String]
  missing : Array[String]
  both_missing : String
  abs_tol : String
  rel_tol : String
  days_tol : Int
}

///|
pub(all) struct Config {
  fields : Array[FieldConfig]
  key : Array[String]
  ignore_left : Array[String]
  ignore_right : Array[String]
  candidates : Json
}

///|
fn engine_error(
  code : String,
  message : String,
  phase : String,
  side? : String,
  record? : Int,
  field? : String,
) -> EngineError {
  {
    code,
    message,
    phase,
    side: match side {
      Some(value) => Json::string(value)
      None => Json::null()
    },
    record: match record {
      Some(value) => Json::number(value.to_double())
      None => Json::null()
    },
    field: match field {
      Some(value) => Json::string(value)
      None => Json::null()
    },
  }
}

///|
fn error_details_to_json(error : EngineError) -> Json {
  Json::object({
    "code": Json::string(error.code),
    "message": Json::string(error.message),
    "phase": Json::string(error.phase),
    "side": error.side,
    "record": error.record,
    "field": error.field,
  })
}

///|
fn error_to_json(error : EngineError) -> Json {
  Json::object({
    "ok": Json::boolean(false),
    "error": error_details_to_json(error),
  })
}

///|
fn success_to_json(key : String, value : Json) -> Json {
  Json::object(Map::Map([("ok", Json::boolean(true)), (key, value)]))
}
