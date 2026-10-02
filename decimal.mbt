///|
priv struct ExactDecimal {
  coefficient : @bigint.BigInt
  scale : Int
}

///|
fn decimal_pow10(power : Int) -> @bigint.BigInt {
  let mut value = @bigint.BigInt::from_int(1)
  for _ in 0..<power {
    value = value * @bigint.BigInt::from_int(10)
  }
  value
}

///|
fn decimal_parse(text : String) -> ExactDecimal? {
  if text.is_empty() {
    return None
  }
  let chars = text.to_array()
  let mut start = 0
  let mut negative = false
  if chars[0] == '+' || chars[0] == '-' {
    negative = chars[0] == '-'
    start = 1
  }
  if start >= chars.length() {
    return None
  }
  let digits = StringBuilder()
  let mut scale = 0
  let mut digit_count = 0
  let mut saw_decimal = false
  let mut integer_digits = 0
  let mut fractional_digits = 0
  for index in start..<chars.length() {
    let ch = chars[index]
    if ch >= '0' && ch <= '9' {
      digits.write_char(ch)
      digit_count += 1
      if saw_decimal {
        scale += 1
        fractional_digits += 1
      } else {
        integer_digits += 1
      }
    } else if ch == '.' && !saw_decimal {
      saw_decimal = true
    } else {
      return None
    }
  }
  if digit_count == 0 ||
    integer_digits == 0 ||
    (saw_decimal && fractional_digits == 0) ||
    digit_count > 64 ||
    scale > 18 {
    return None
  }
  let mut coefficient = @bigint.BigInt::from_string(digits.to_string())
  if negative {
    coefficient = -coefficient
  }
  Some(decimal_normalize({ coefficient, scale, }))
}

///|
fn decimal_normalize(value : ExactDecimal) -> ExactDecimal {
  let mut coefficient = value.coefficient
  let mut scale = value.scale
  let ten = @bigint.BigInt::from_int(10)
  while scale > 0 && coefficient % ten == @bigint.BigInt::from_int(0) {
    coefficient = coefficient / ten
    scale -= 1
  }
  if coefficient == @bigint.BigInt::from_int(0) {
    return { coefficient: @bigint.BigInt::from_int(0), scale: 0, }
  }
  { coefficient, scale, }
}

///|
fn decimal_align(
  left : ExactDecimal,
  right : ExactDecimal,
) -> (@bigint.BigInt, @bigint.BigInt, Int) {
  let scale = if left.scale > right.scale { left.scale } else { right.scale }
  (
    left.coefficient * decimal_pow10(scale - left.scale),
    right.coefficient * decimal_pow10(scale - right.scale),
    scale,
  )
}

///|
fn decimal_add(left : ExactDecimal, right : ExactDecimal) -> ExactDecimal {
  let (a, b, scale) = decimal_align(left, right)
  decimal_normalize({ coefficient: a + b, scale, })
}

///|
fn decimal_subtract(left : ExactDecimal, right : ExactDecimal) -> ExactDecimal {
  decimal_add(left, { coefficient: -right.coefficient, scale: right.scale, })
}

///|
fn decimal_multiply(left : ExactDecimal, right : ExactDecimal) -> ExactDecimal {
  decimal_normalize({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  })
}

///|
fn decimal_compare(left : ExactDecimal, right : ExactDecimal) -> Int {
  let (a, b, _) = decimal_align(left, right)
  if a < b {
    -1
  } else if a > b {
    1
  } else {
    0
  }
}

///|
fn decimal_abs(value : ExactDecimal) -> ExactDecimal {
  if value.coefficient < @bigint.BigInt::from_int(0) {
    { coefficient: -value.coefficient, scale: value.scale, }
  } else {
    value
  }
}

///|
fn decimal_format(value : ExactDecimal) -> String {
  let normalized = decimal_normalize(value)
  let raw = normalized.coefficient.to_string()
  let negative = raw.has_prefix("-")
  let digits = if negative { raw[1:].to_owned() } else { raw }
  if normalized.scale == 0 {
    raw
  } else {
    let padded = if digits.length() <= normalized.scale {
      "0".repeat(normalized.scale + 1 - digits.length()) + digits
    } else {
      digits
    }
    let split = padded.length() - normalized.scale
    (if negative { "-" } else { "" }) +
    padded[:split].to_owned() +
    "." +
    padded[split:].to_owned()
  }
}
