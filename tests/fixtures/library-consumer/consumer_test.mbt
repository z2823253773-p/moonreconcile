///|
test "external_consumer_structured_error" {
  let result = @engine.invoke("invalid")
  let parsed = @json.parse(result)
  assert_eq(match parsed { Json::Object(fields) => fields.get("ok")
 _ => None }, Some(Json::boolean(false)))
}

///|
test "external_consumer_pure_compare" {
  let request = "{\"op\":\"compare\",\"left_csv\":\"id,v\\nA,x\\n\",\"right_csv\":\"id,v\\nA,x\\n\",\"config\":{\"schema_version\":1,\"fields\":[{\"name\":\"id\",\"left\":\"id\",\"right\":\"id\",\"type\":\"text\",\"compare\":false},{\"name\":\"value\",\"left\":\"v\",\"right\":\"v\",\"type\":\"text\"}],\"key\":[\"id\"]}}"
  let parsed = @json.parse(@engine.invoke(request))
  assert_eq(match parsed { Json::Object(fields) => fields.get("ok")
 _ => None }, Some(Json::boolean(true)))
}
