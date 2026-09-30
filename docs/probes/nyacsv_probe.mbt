///|
pub fn parse_text(s : String) -> @csv.CSV {
  @csv.CSV::parse_string(s)
}
