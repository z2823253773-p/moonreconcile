///|
fn date_is_leap_year(year : Int) -> Bool {
  year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

///|
fn date_day_index(year : Int, month : Int, day : Int) -> Int {
  let prior_year = year - 1
  let mut total = prior_year * 365 +
    prior_year / 4 -
    prior_year / 100 +
    prior_year / 400
  let month_lengths = [
    31,
    if date_is_leap_year(year) {
      29
    } else {
      28
    },
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  for index in 0..<(month - 1) {
    total += month_lengths[index]
  }
  total + day
}

///|
fn date_parse_digits(chars : Array[Char], start : Int, end : Int) -> Int {
  let mut value = 0
  for index in start..<end {
    value = value * 10 + chars[index].to_int() - '0'.to_int()
  }
  value
}

///|
fn date_parse(text : String) -> (String, Int)? {
  if text.length() != 10 {
    return None
  }
  let chars = text.to_array()
  if chars[4] != '-' || chars[7] != '-' {
    return None
  }
  for index in 0..<10 {
    if index != 4 && index != 7 && (chars[index] < '0' || chars[index] > '9') {
      return None
    }
  }
  let year = date_parse_digits(chars, 0, 4)
  let month = date_parse_digits(chars, 5, 7)
  let day = date_parse_digits(chars, 8, 10)
  if year < 1 || month < 1 || month > 12 {
    return None
  }
  let month_lengths = [
    31,
    if date_is_leap_year(year) {
      29
    } else {
      28
    },
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  if day < 1 || day > month_lengths[month - 1] {
    return None
  }
  Some((text, date_day_index(year, month, day)))
}
