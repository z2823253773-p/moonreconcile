///|
fn config_error(message : String, field? : String) -> EngineError {
  match field {
    Some(value) =>
      engine_error("invalid_config", message, "configuration", field=value)
    None => engine_error("invalid_config", message, "configuration")
  }
}

///|
fn object_member(object : Map[String, Json], key : String) -> Json? {
  object.get(key)
}

///|
fn json_string(value : Json?) -> String? {
  match value {
    Some(Json::String(text)) => Some(text)
    _ => None
  }
}

///|
fn json_array(value : Json?) -> Array[Json]? {
  match value {
    Some(Json::Array(items)) => Some(items)
    _ => None
  }
}

///|
fn json_object(value : Json?) -> Map[String, Json]? {
  match value {
    Some(Json::Object(fields)) => Some(fields)
    _ => None
  }
}

///|
fn reject_unknown_keys(
  object : Map[String, Json],
  allowed : Array[String],
  label : String,
) -> EngineError? {
  for key in object.keys() {
    if !allowed.contains(key) {
      return Some(
        config_error("unknown property '\{key}' in \{label}", field=key),
      )
    }
  }
  None
}

///|
fn parse_string_array(
  value : Json?,
  name : String,
) -> Result[Array[String], EngineError] {
  match json_array(value) {
    None => Err(config_error("\{name} must be an array of strings", field=name))
    Some(items) => {
      let values : Array[String] = []
      for item in items {
        match item {
          Json::String(text) => values.push(text)
          _ =>
            return Err(
              config_error("\{name} must contain only strings", field=name),
            )
        }
      }
      Ok(values)
    }
  }
}

///|
fn parse_string_map(
  value : Json?,
  name : String,
) -> Result[Map[String, String], EngineError] {
  match json_object(value) {
    None =>
      Err(
        config_error("\{name} must be an object of string values", field=name),
      )
    Some(items) => {
      let result : Map[String, String] = Map([])
      for key, item in items {
        match item {
          Json::String(text) => result[key] = text
          _ =>
            return Err(
              config_error("\{name} values must be strings", field=name),
            )
        }
      }
      Ok(result)
    }
  }
}

///|
fn valid_nonnegative_decimal(text : String) -> Bool {
  if text.is_empty() {
    return false
  }
  let saw_digit = Ref(false)
  let saw_point = Ref(false)
  for ch in text {
    if ch >= '0' && ch <= '9' {
      saw_digit.val = true
    } else if ch == '.' && !saw_point.val {
      saw_point.val = true
    } else {
      return false
    }
  }
  saw_digit.val && text[0] != '.' && text[text.length() - 1] != '.'
}

///|
fn parse_int_json(value : Json?, name : String) -> Result[Int, EngineError] {
  match value {
    Some(Json::Number(number, ..)) => {
      if number != number.floor() {
        return Err(config_error("\{name} must be an integer", field=name))
      }
      let parsed = number.to_int()
      if parsed >= 0 {
        Ok(parsed)
      } else {
        Err(config_error("\{name} must be nonnegative", field=name))
      }
    }
    _ => Err(config_error("\{name} must be an integer", field=name))
  }
}

///|
fn parse_config(json : Json) -> Result[Config, EngineError] {
  match json {
    Json::Object(object) => {
      match
        reject_unknown_keys(
          object,
          [
            "schema_version", "draft", "fields", "key", "ignore_left", "ignore_right",
            "candidates",
          ],
          "config",
        ) {
        Some(error) => return Err(error)
        None => ()
      }
      match
        parse_int_json(
          object_member(object, "schema_version"),
          "schema_version",
        ) {
        Ok(1) => ()
        Ok(_) =>
          return Err(
            config_error("schema_version must equal 1", field="schema_version"),
          )
        Err(error) => return Err(error)
      }
      match object_member(object, "draft") {
        None => ()
        Some(Json::True) =>
          return Err(
            config_error(
              "draft config must be edited before checking",
              field="draft",
            ),
          )
        Some(Json::False) => ()
        _ => return Err(config_error("draft must be a boolean", field="draft"))
      }
      let raw_fields = match json_array(object_member(object, "fields")) {
        Some(items) => items
        None =>
          return Err(config_error("fields must be an array", field="fields"))
      }
      if raw_fields.is_empty() {
        return Err(
          config_error("at least one field mapping is required", field="fields"),
        )
      }
      let fields : Array[FieldConfig] = []
      let names : Array[String] = []
      let left_sources : Array[String] = []
      let right_sources : Array[String] = []
      for raw_field in raw_fields {
        let field = match raw_field {
          Json::Object(item) => item
          _ =>
            return Err(
              config_error(
                "each fields entry must be an object",
                field="fields",
              ),
            )
        }
        match
          reject_unknown_keys(
            field,
            [
              "name", "left", "right", "type", "compare", "trim_ascii", "lower_ascii",
              "left_values", "right_values", "missing", "both_missing", "abs_tol",
              "rel_tol", "days_tol",
            ],
            "field",
          ) {
          Some(error) => return Err(error)
          None => ()
        }
        let name = match json_string(object_member(field, "name")) {
          Some(value) if !value.is_blank() => value
          _ =>
            return Err(
              config_error("field name must be a nonblank string", field="name"),
            )
        }
        let left = match json_string(object_member(field, "left")) {
          Some(value) if !value.is_empty() => value
          _ =>
            return Err(
              config_error(
                "left source column must be a nonempty string",
                field=name,
              ),
            )
        }
        let right = match json_string(object_member(field, "right")) {
          Some(value) if !value.is_empty() => value
          _ =>
            return Err(
              config_error(
                "right source column must be a nonempty string",
                field=name,
              ),
            )
        }
        let field_type = match json_string(object_member(field, "type")) {
          Some("text") => "text"
          Some("decimal") => "decimal"
          Some("date") => "date"
          _ =>
            return Err(
              config_error(
                "field type must be text, decimal, or date",
                field=name,
              ),
            )
        }
        let compare = match object_member(field, "compare") {
          None => true
          Some(Json::True) => true
          Some(Json::False) => false
          _ => return Err(config_error("compare must be a boolean", field=name))
        }
        let trim_ascii = match object_member(field, "trim_ascii") {
          None => false
          Some(Json::True) => true
          Some(Json::False) => false
          _ =>
            return Err(config_error("trim_ascii must be a boolean", field=name))
        }
        let lower_ascii = match object_member(field, "lower_ascii") {
          None => false
          Some(Json::True) => true
          Some(Json::False) => false
          _ =>
            return Err(
              config_error("lower_ascii must be a boolean", field=name),
            )
        }
        let left_values = match object_member(field, "left_values") {
          None => Map([])
          Some(value) =>
            match parse_string_map(Some(value), "left_values") {
              Ok(map) => map
              Err(error) => return Err(error)
            }
        }
        let right_values = match object_member(field, "right_values") {
          None => Map([])
          Some(value) =>
            match parse_string_map(Some(value), "right_values") {
              Ok(map) => map
              Err(error) => return Err(error)
            }
        }
        let missing = match object_member(field, "missing") {
          None => []
          Some(value) =>
            match parse_string_array(Some(value), "missing") {
              Ok(values) => values
              Err(error) => return Err(error)
            }
        }
        let both_missing = match
          json_string(object_member(field, "both_missing")) {
          None => "equal"
          Some("equal") => "equal"
          Some("issue") => "issue"
          Some(_) =>
            return Err(
              config_error("both_missing must be equal or issue", field=name),
            )
        }
        let abs_tol = match json_string(object_member(field, "abs_tol")) {
          None => "0"
          Some(value) if valid_nonnegative_decimal(value) => value
          _ =>
            return Err(
              config_error(
                "abs_tol must be a nonnegative decimal string",
                field=name,
              ),
            )
        }
        let rel_tol = match json_string(object_member(field, "rel_tol")) {
          None => "0"
          Some(value) if valid_nonnegative_decimal(value) => value
          _ =>
            return Err(
              config_error(
                "rel_tol must be a nonnegative decimal string",
                field=name,
              ),
            )
        }
        let days_tol = match object_member(field, "days_tol") {
          None => 0
          Some(value) =>
            match parse_int_json(Some(value), "days_tol") {
              Ok(days) => days
              Err(error) => return Err(error)
            }
        }
        if names.contains(name) {
          return Err(
            config_error("duplicate logical field name: \{name}", field=name),
          )
        }
        if left_sources.contains(left) {
          return Err(
            config_error(
              "left source column is mapped more than once: \{left}",
              field=name,
            ),
          )
        }
        if right_sources.contains(right) {
          return Err(
            config_error(
              "right source column is mapped more than once: \{right}",
              field=name,
            ),
          )
        }
        if (!compare && !left_values.is_empty()) ||
          (!compare && !right_values.is_empty()) {
          return Err(
            config_error(
              "identity-only fields cannot declare content value maps",
              field=name,
            ),
          )
        }
        names.push(name)
        left_sources.push(left)
        right_sources.push(right)
        fields.push({
          name,
          left,
          right,
          field_type,
          compare,
          trim_ascii,
          lower_ascii,
          left_values,
          right_values,
          missing,
          both_missing,
          abs_tol,
          rel_tol,
          days_tol,
        })
      }
      let key = match object_member(object, "key") {
        None => []
        Some(value) =>
          match parse_string_array(Some(value), "key") {
            Ok(values) => values
            Err(error) => return Err(error)
          }
      }
      for name in key {
        if !names.contains(name) {
          return Err(
            config_error("key references an unknown field: \{name}", field=name),
          )
        }
      }
      let ignore_left = match object_member(object, "ignore_left") {
        None => []
        Some(value) =>
          match parse_string_array(Some(value), "ignore_left") {
            Ok(values) => values
            Err(error) => return Err(error)
          }
      }
      let ignore_right = match object_member(object, "ignore_right") {
        None => []
        Some(value) =>
          match parse_string_array(Some(value), "ignore_right") {
            Ok(values) => values
            Err(error) => return Err(error)
          }
      }
      for column in ignore_left {
        if left_sources.contains(column) {
          return Err(
            config_error(
              "ignored left column is also mapped: \{column}",
              field=column,
            ),
          )
        }
      }
      for column in ignore_right {
        if right_sources.contains(column) {
          return Err(
            config_error(
              "ignored right column is also mapped: \{column}",
              field=column,
            ),
          )
        }
      }
      let candidates = match object_member(object, "candidates") {
        None => Json::null()
        Some(value) => value
      }
      match candidates {
        Json::Null => ()
        Json::Object(candidate) => {
          match
            reject_unknown_keys(
              candidate,
              ["fields", "threshold", "blocking"],
              "candidates",
            ) {
            Some(error) => return Err(error)
            None => ()
          }
          let candidate_fields = match json_array(candidate.get("fields")) {
            Some(items) if !items.is_empty() => items
            _ =>
              return Err(
                config_error(
                  "candidate fields must be a nonempty array",
                  field="candidates.fields",
                ),
              )
          }
          let candidate_names : Array[String] = []
          for item in candidate_fields {
            let spec = match item {
              Json::Object(value) => value
              _ =>
                return Err(
                  config_error(
                    "candidate field entries must be objects",
                    field="candidates.fields",
                  ),
                )
            }
            match
              reject_unknown_keys(
                spec,
                ["field", "metric", "weight"],
                "candidate field",
              ) {
              Some(error) => return Err(error)
              None => ()
            }
            let field_name = match json_string(spec.get("field")) {
              Some(value) if names.contains(value) => value
              _ =>
                return Err(
                  config_error(
                    "candidate field must reference a mapped field",
                    field="candidates.fields",
                  ),
                )
            }
            let metric = match json_string(spec.get("metric")) {
              Some(value) => value
              _ =>
                return Err(
                  config_error(
                    "candidate metric must be a string",
                    field="candidates.fields",
                  ),
                )
            }
            let weight = match
              parse_int_json(spec.get("weight"), "candidate weight") {
              Ok(value) if value >= 1 && value <= 10000 => value
              _ =>
                return Err(
                  config_error(
                    "candidate weight must be between 1 and 10000",
                    field="candidates.fields",
                  ),
                )
            }
            let mapped_index = match names.search(field_name) {
              Some(index) => index
              None =>
                return Err(
                  config_error(
                    "candidate field must reference a mapped field",
                    field="candidates.fields",
                  ),
                )
            }
            let mapped_field = fields[mapped_index]
            if metric == "edit" || metric == "exact" {
              if mapped_field.field_type != "text" {
                return Err(
                  config_error(
                    "exact and edit metrics require text fields",
                    field=field_name,
                  ),
                )
              }
            } else if metric == "decimal" {
              if mapped_field.field_type != "decimal" {
                return Err(
                  config_error(
                    "decimal metric requires a decimal field",
                    field=field_name,
                  ),
                )
              }
            } else if metric == "date" {
              if mapped_field.field_type != "date" {
                return Err(
                  config_error(
                    "date metric requires a date field",
                    field=field_name,
                  ),
                )
              }
            } else {
              return Err(
                config_error(
                  "unknown candidate metric: \{metric}",
                  field=metric,
                ),
              )
            }
            if candidate_names.contains(field_name) {
              return Err(
                config_error(
                  "candidate field is repeated: \{field_name}",
                  field=field_name,
                ),
              )
            }
            candidate_names.push(field_name)
            ignore(weight)
          }
          match
            parse_int_json(candidate.get("threshold"), "candidate threshold") {
            Ok(value) if value >= 1 && value <= 10000 => ()
            _ =>
              return Err(
                config_error(
                  "candidate threshold must be between 1 and 10000",
                  field="candidates.threshold",
                ),
              )
          }
          match candidate.get("blocking") {
            None => ()
            Some(Json::Array(groups)) =>
              for group in groups {
                match group {
                  Json::Array(group_fields) if !group_fields.is_empty() =>
                    for name in group_fields {
                      match name {
                        Json::String(field_name) if names.contains(field_name) =>
                          ()
                        _ =>
                          return Err(
                            config_error(
                              "blocking fields must reference mapped field names",
                              field="candidates.blocking",
                            ),
                          )
                      }
                    }
                  _ =>
                    return Err(
                      config_error(
                        "blocking must contain nonempty arrays of field names",
                        field="candidates.blocking",
                      ),
                    )
                }
              }
            _ =>
              return Err(
                config_error(
                  "blocking must be an array",
                  field="candidates.blocking",
                ),
              )
          }
        }
        _ =>
          return Err(
            config_error(
              "candidates must be null or an object",
              field="candidates",
            ),
          )
      }
      Ok({ fields, key, ignore_left, ignore_right, candidates })
    }
    _ => Err(config_error("config must be a JSON object"))
  }
}

///|
fn normalize_config(config : Config) -> Json {
  let normalized_fields : Array[Json] = []
  for field in config.fields {
    normalized_fields.push(
      Json::object({
        "name": Json::string(field.name),
        "left": Json::string(field.left),
        "right": Json::string(field.right),
        "type": Json::string(field.field_type),
        "compare": Json::boolean(field.compare),
        "trim_ascii": Json::boolean(field.trim_ascii),
        "lower_ascii": Json::boolean(field.lower_ascii),
        "left_values": Json::object(
          field.left_values.map(fn(_key, value) { Json::string(value) }),
        ),
        "right_values": Json::object(
          field.right_values.map(fn(_key, value) { Json::string(value) }),
        ),
        "missing": Json::array(field.missing.map(Json::string)),
        "both_missing": Json::string(field.both_missing),
        "abs_tol": Json::string(field.abs_tol),
        "rel_tol": Json::string(field.rel_tol),
        "days_tol": Json::number(field.days_tol.to_double()),
      }),
    )
  }
  Json::object({
    "schema_version": Json::number(1.0),
    "draft": Json::boolean(false),
    "fields": Json::array(normalized_fields),
    "key": Json::array(config.key.map(Json::string)),
    "ignore_left": Json::array(config.ignore_left.map(Json::string)),
    "ignore_right": Json::array(config.ignore_right.map(Json::string)),
    "candidates": config.candidates,
  })
}
