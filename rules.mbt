///|
pub(all) struct NormalizedValue {
  raw : String
  transformed : String
  canonical : String?
  missing : Bool
  invalid : Bool
  rules : Array[String]
}

///|
pub(all) struct FieldComparison {
  field : String
  field_type : String
  left_raw : String
  right_raw : String
  left_transformed : String
  right_transformed : String
  left_canonical : String?
  right_canonical : String?
  left_missing : Bool
  right_missing : Bool
  status : String
  rules : Array[String]
  difference : String?
  tolerance : String?
  explanation : String
}

///|
fn ascii_whitespace(ch : Char) -> Bool {
  ch == ' ' ||
  ch == '\t' ||
  ch == '\n' ||
  ch == '\r' ||
  ch == '\u{000c}' ||
  ch == '\u{000b}'
}

///|
fn ascii_trim(text : String) -> String {
  let chars = text.to_array()
  let mut start = 0
  let mut end = chars.length()
  while start < end && ascii_whitespace(chars[start]) {
    start += 1
  }
  while end > start && ascii_whitespace(chars[end - 1]) {
    end -= 1
  }
  String::from_array(chars[start:end])
}

///|
fn ascii_lower(text : String) -> String {
  let chars = text.to_array()
  for index in 0..<chars.length() {
    if chars[index] >= 'A' && chars[index] <= 'Z' {
      chars[index] = (chars[index].to_int() + 32).unsafe_to_char()
    }
  }
  String::from_array(chars)
}

///|
pub fn normalize_value(
  raw : String,
  field : FieldConfig,
  side : String,
) -> NormalizedValue {
  let transformed_rules : Array[String] = []
  let mut transformed = raw
  if field.trim_ascii {
    transformed = ascii_trim(transformed)
    transformed_rules.push("trim_ascii")
  }
  if field.lower_ascii {
    transformed = ascii_lower(transformed)
    transformed_rules.push("lower_ascii")
  }
  let mapping = match side {
    "left" => field.left_values
    "right" => field.right_values
    _ => Map([])
  }
  match mapping.get(transformed) {
    Some(value) => {
      transformed = value
      transformed_rules.push("value_map")
    }
    None => ()
  }
  let missing = field.missing.contains(transformed)
  if missing {
    transformed_rules.push("missing_marker")
    return {
      raw,
      transformed,
      canonical: None,
      missing: true,
      invalid: false,
      rules: transformed_rules,
    }
  }
  match field.field_type {
    "text" =>
      {
        raw,
        transformed,
        canonical: Some(transformed),
        missing: false,
        invalid: false,
        rules: transformed_rules,
      }
    "decimal" =>
      match decimal_parse(transformed) {
        Some(value) => {
          transformed_rules.push("decimal_canonicalization")
          {
            raw,
            transformed,
            canonical: Some(decimal_format(value)),
            missing: false,
            invalid: false,
            rules: transformed_rules,
          }
        }
        None =>
          {
            raw,
            transformed,
            canonical: None,
            missing: false,
            invalid: true,
            rules: transformed_rules,
          }
      }
    "date" =>
      match date_parse(transformed) {
        Some((canonical, _)) => {
          transformed_rules.push("date_canonicalization")
          {
            raw,
            transformed,
            canonical: Some(canonical),
            missing: false,
            invalid: false,
            rules: transformed_rules,
          }
        }
        None =>
          {
            raw,
            transformed,
            canonical: None,
            missing: false,
            invalid: true,
            rules: transformed_rules,
          }
      }
    _ =>
      {
        raw,
        transformed,
        canonical: None,
        missing: false,
        invalid: true,
        rules: transformed_rules,
      }
  }
}

///|
pub fn compare_field(
  left : String,
  right : String,
  field : FieldConfig,
) -> FieldComparison {
  let l = normalize_value(left, field, "left")
  let r = normalize_value(right, field, "right")
  let rules = l.rules + r.rules
  let mut difference : String? = None
  let mut tolerance : String? = None
  let mut status = "different"
  let mut explanation = "canonical_values_differ"
  if l.invalid || r.invalid {
    status = "invalid_value"
    explanation = "value_does_not_match_declared_type"
  } else if l.missing && r.missing {
    if field.both_missing == "issue" {
      status = "different"
      explanation = "both_missing_requires_review"
    } else if left == right {
      status = "equal"
      explanation = "both_values_missing"
    } else {
      status = "equivalent_by_rule"
      explanation = "both_values_missing_by_policy"
    }
  } else if l.missing || r.missing {
    status = "different"
    explanation = "one_value_missing"
  } else if field.field_type == "decimal" {
    match
      (
        decimal_parse(l.transformed),
        decimal_parse(r.transformed),
        decimal_parse(field.abs_tol),
        decimal_parse(field.rel_tol),
      ) {
      (Some(a), Some(b), Some(abs_tol), Some(rel_tol)) => {
        let delta = decimal_subtract(a, b)
        let max_magnitude = if decimal_compare(decimal_abs(a), decimal_abs(b)) >=
          0 {
          decimal_abs(a)
        } else {
          decimal_abs(b)
        }
        let rel_threshold = decimal_multiply(rel_tol, max_magnitude)
        let threshold = if decimal_compare(abs_tol, rel_threshold) >= 0 {
          abs_tol
        } else {
          rel_threshold
        }
        difference = Some(decimal_format(delta))
        tolerance = Some(decimal_format(threshold))
        if decimal_compare(decimal_abs(delta), threshold) <= 0 {
          if left == right && delta.coefficient.is_zero() {
            status = "equal"
            explanation = "raw_values_equal"
          } else {
            status = "equivalent_by_rule"
            explanation = "decimal_difference_within_tolerance"
          }
        } else {
          status = "different"
          explanation = "decimal_difference_exceeds_tolerance"
        }
        if left != right {
          rules.push("decimal_tolerance")
        }
      }
      _ => {
        status = "invalid_value"
        explanation = "invalid_decimal_tolerance"
      }
    }
  } else if field.field_type == "date" {
    match (date_parse(l.transformed), date_parse(r.transformed)) {
      (Some((_, left_day)), Some((_, right_day))) => {
        let delta = left_day - right_day
        let day_tolerance = field.days_tol
        difference = Some(delta.to_string())
        tolerance = Some(day_tolerance.to_string())
        if (if delta < 0 { -delta } else { delta }) <= day_tolerance {
          if left == right && delta == 0 {
            status = "equal"
            explanation = "raw_values_equal"
          } else {
            status = "equivalent_by_rule"
            explanation = "date_difference_within_day_tolerance"
          }
        } else {
          status = "different"
          explanation = "date_difference_exceeds_day_tolerance"
        }
        if left != right {
          rules.push("date_days_tolerance")
        }
      }
      _ => {
        status = "invalid_value"
        explanation = "invalid_date"
      }
    }
  } else if l.canonical == r.canonical {
    if left == right {
      status = "equal"
      explanation = "raw_values_equal"
    } else {
      status = "equivalent_by_rule"
      explanation = "values_equal_after_configured_transforms"
    }
  }
  {
    field: field.name,
    field_type: field.field_type,
    left_raw: left,
    right_raw: right,
    left_transformed: l.transformed,
    right_transformed: r.transformed,
    left_canonical: l.canonical,
    right_canonical: r.canonical,
    left_missing: l.missing,
    right_missing: r.missing,
    status,
    rules,
    difference,
    tolerance,
    explanation,
  }
}
