///|
pub fn decode_response(request : String) -> Json {
  @json.parse(@engine.invoke(request)) catch { _ => Json::null() }
}
