///|
fn must_csv(text : String, side : String) -> Table {
  match parse_csv(text, side) {
    Ok(value) => value
    Err(_) => { headers: [], rows: [] }
  }
}

///|
fn must_config(key? : Bool = false, candidates? : Bool = false) -> Config {
  let no_map : Map[String, String] = Map([])
  let id = {
    name: "id",
    left: "id",
    right: "id",
    field_type: "text",
    compare: false,
    trim_ascii: false,
    lower_ascii: false,
    left_values: no_map,
    right_values: no_map,
    missing: [],
    both_missing: "equal",
    abs_tol: "0",
    rel_tol: "0",
    days_tol: 0,
  }
  let value = {
    name: "value",
    left: "value",
    right: "value",
    field_type: "text",
    compare: true,
    trim_ascii: false,
    lower_ascii: false,
    left_values: no_map,
    right_values: no_map,
    missing: [],
    both_missing: "equal",
    abs_tol: "0",
    rel_tol: "0",
    days_tol: 0,
  }
  let candidate_spec = if candidates {
    Json::object({
      "fields": Json::array([
        Json::object({
          "field": Json::string("value"),
          "metric": Json::string("exact"),
          "weight": Json::number(1.0),
        }),
      ]),
      "threshold": Json::number(10000.0),
      "blocking": Json::array([]),
    })
  } else {
    Json::null()
  }
  {
    fields: [id, value],
    key: if key {
      ["id"]
    } else {
      []
    },
    ignore_left: [],
    ignore_right: [],
    candidates: candidate_spec,
  }
}

///|
fn must_decisions(csv : String) -> Array[Decision] {
  match parse_decisions(csv) {
    Ok(value) => value
    Err(_) => []
  }
}

///|
fn review_fixture(
  key? : Bool = false,
  candidates? : Bool = false,
) -> (Table, Table, Config) {
  let left = must_csv("id,value\nA,old\n", "left")
  let right = must_csv("id,value\nB,new\n", "right")
  let config = must_config(key~, candidates~)
  (left, right, config)
}

///|
test "human_acceptance_recomputes_and_preserves_field_difference" {
  let (left, right, config) = review_fixture()
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,verified\n",
  )
  let result = match apply_decisions(base, decisions, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_eq(result.pairs.length(), 1)
  assert_eq(result.pairs[0].source, "human_review")
  assert_eq(result.pairs[0].fields[0].status, "different")
  assert_eq(result.exit_code, 1)
}

///|
test "rejecting_candidate_keeps_both_rows_pending" {
  let left = must_csv("id,value\nA,same\n", "left")
  let right = must_csv("id,value\nB,same\n", "right")
  let config = must_config(candidates=true)
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\nreject,L1,R1,not same\n",
  )
  let result = match apply_decisions(base, decisions, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_eq(result.pairs.length(), 0)
  assert_eq(result.pending_left, 1)
  assert_eq(result.pending_right, 1)
  match result_to_json(result) {
    Json::Object(root) =>
      match root.get("candidates") {
        Some(Json::Array([Json::Object(candidate)])) =>
          assert_eq(candidate.get("suggested"), Some(Json::boolean(false)))
        _ => assert_true(false)
      }
    _ => assert_true(false)
  }
}

///|
test "side_unmatched_is_reported_and_exits_one" {
  let (left, right, config) = review_fixture()
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\nleft_unmatched,L1,,no record\nright_unmatched,,R1,no record\n",
  )
  let result = match apply_decisions(base, decisions, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_eq(result.unmatched_left_records, [1])
  assert_eq(result.unmatched_right_records, [1])
  assert_eq(result.exit_code, 1)
}

///|
test "exact_key_endpoints_are_locked" {
  let left = must_csv("id,value\nA,old\n", "left")
  let right = must_csv("id,value\nA,new\n", "right")
  let config = must_config(key=true)
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\nreject,L1,R1,change\n",
  )
  assert_true(apply_decisions(base, decisions, left, right, config) is Err(_))
}

///|
test "conflicting_batch_is_rejected_atomically" {
  let (left, right, config) = review_fixture()
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,first\nleft_unmatched,L1,,conflict\n",
  )
  assert_true(apply_decisions(base, decisions, left, right, config) is Err(_))
  assert_eq(base.pairs.length(), 0)
  assert_eq(base.pending_left, 1)
}

///|
test "blank_action_rows_remain_unfinished" {
  let (left, right, config) = review_fixture()
  let base = compare_tables(left, right, config)
  let result = match
    apply_decisions(
      base,
      must_decisions("action,left_id,right_id,reason\n,,,\n"),
      left,
      right,
      config,
    ) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_eq(result.pairs.length(), 0)
  assert_eq(result.pending_left, 1)
  assert_eq(result.pending_right, 1)
}

///|
test "decision_header_and_unknown_action_are_strict" {
  match parse_decisions("left_id,action,right_id,reason\nL1,accept,R1,ok\n") {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_decision_schema")
  }
  match
    parse_decisions("action,left_id,right_id,reason\nmaybe,L1,R1,unknown\n") {
    Ok(_) => assert_true(false)
    Err(error) => assert_eq(error.code, "invalid_decision_action")
  }
}

///|
test "noncandidate_accept_requires_reason" {
  let (left, right, config) = review_fixture()
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,   \n",
  )
  assert_true(apply_decisions(base, decisions, left, right, config) is Err(_))
}

///|
test "accept_and_reject_conflict_rejects_whole_batch" {
  let (left, right, config) = review_fixture()
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,manual\nreject,L1,R1,exclude\n",
  )
  assert_true(apply_decisions(base, decisions, left, right, config) is Err(_))
  assert_eq(base.pending_left, 1)
  assert_eq(base.pending_right, 1)
}

///|
test "two_accepts_cannot_share_an_endpoint" {
  let left = must_csv("id,value\nA,x\n", "left")
  let right = must_csv("id,value\nB,x\nC,x\n", "right")
  let config = must_config()
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,one\naccept,L1,R2,two\n",
  )
  assert_true(apply_decisions(base, decisions, left, right, config) is Err(_))
}

///|
test "accept_and_unmatched_conflict_rejects_whole_batch" {
  let (left, right, config) = review_fixture()
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,manual\nleft_unmatched,L1,,no pair\n",
  )
  assert_true(apply_decisions(base, decisions, left, right, config) is Err(_))
}

///|
test "threshold_qualified_candidate_accept_is_not_an_override" {
  let left = must_csv("id,value\nA,same\n", "left")
  let right = must_csv("id,value\nB,same\n", "right")
  let config = must_config(candidates=true)
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,reviewed\n",
  )
  let result = match apply_decisions(base, decisions, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_true(!result.pairs[0].is_override)
  match result_to_json(result) {
    Json::Object(root) =>
      match root.get("decisions") {
        Some(Json::Array([Json::Object(entry)])) =>
          assert_eq(entry.get("override"), Some(Json::boolean(false)))
        _ => assert_true(false)
      }
    _ => assert_true(false)
  }
}

///|
test "identical_decision_repeat_is_idempotent" {
  let (left, right, config) = review_fixture()
  let base = compare_tables(left, right, config)
  let repeated = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,manual\naccept,L1,R1,manual\n",
  )
  let single = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,manual\n",
  )
  let twice = match apply_decisions(base, repeated, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  let once = match apply_decisions(base, single, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_eq(result_to_json(twice), result_to_json(once))
}

///|
test "decision_order_does_not_change_semantic_json" {
  let left = must_csv("id,value\nA,old\nB,old\n", "left")
  let right = must_csv("id,value\nC,new\nD,new\n", "right")
  let config = must_config()
  let base = compare_tables(left, right, config)
  let forward = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,first\naccept,L2,R2,second\n",
  )
  let reverse = must_decisions(
    "action,left_id,right_id,reason\naccept,L2,R2,second\naccept,L1,R1,first\n",
  )
  let a = match apply_decisions(base, forward, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  let b = match apply_decisions(base, reverse, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_eq(result_to_json(a), result_to_json(b))
}

///|
test "no_key_reviewed_equal_rows_can_finish_without_key_anomaly_exit" {
  let left = must_csv("id,value\nA,same\n", "left")
  let right = must_csv("id,value\nB,same\n", "right")
  let config = must_config()
  let base = compare_tables(left, right, config)
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,confirmed\n",
  )
  let result = match apply_decisions(base, decisions, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_eq(result.exit_code, 0)
}

///|
test "resource_limited_manual_pair_keeps_incomplete_history" {
  let left = must_csv("id,value\nA,x\nB,y\n", "left")
  let right = must_csv("id,value\nC,x\nD,y\n", "right")
  let config = must_config(candidates=true)
  let base = compare_tables_with_budget(left, right, config, {
    pairs: 1,
    edit_cells: 100,
    max_component_side: 10,
    max_edit_codepoints: 10,
  })
  assert_eq(base.status, "incomplete")
  let decisions = must_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,manual disposition\n",
  )
  let result = match apply_decisions(base, decisions, left, right, config) {
    Ok(value) => value
    Err(_) => {
      assert_true(false)
      base
    }
  }
  assert_eq(result.status, "incomplete")
  assert_eq(result.exit_code, 3)
  assert_eq(result.unprocessed_left_records, [2])
  assert_eq(result.unprocessed_right_records, [2])
}

///|
test "decision_parser_preserves_quoted_multiline_reason" {
  let decisions = parse_decisions(
    "action,left_id,right_id,reason\naccept,L1,R1,\"checked, then\nconfirmed\"\n",
  ).unwrap()
  assert_eq(decisions[0].reason, "checked, then\nconfirmed")
}

///|
test "resolve_rebuilds_base_and_applies_complete_decision_table" {
  let request = "{\"op\":\"resolve\",\"left_csv\":\"id,value\\nA,old\\n\",\"right_csv\":\"id,value\\nB,new\\n\",\"config\":{\"schema_version\":1,\"fields\":[{\"name\":\"id\",\"left\":\"id\",\"right\":\"id\",\"type\":\"text\",\"compare\":false},{\"name\":\"value\",\"left\":\"value\",\"right\":\"value\",\"type\":\"text\"}]},\"decisions_csv\":\"action,left_id,right_id,reason\\naccept,L1,R1,reviewed\\n\"}"
  let response = @json.parse(invoke(request))
  match response {
    Json::Object(root) => {
      assert_eq(root.get("ok"), Some(Json::boolean(true)))
      match root.get("result") {
        Some(Json::Object(result)) => {
          match result.get("pairs") {
            Some(Json::Array([Json::Object(pair)])) =>
              assert_eq(pair.get("source"), Some(Json::string("human_review")))
            _ => assert_true(false)
          }
          assert_eq(result.get("exit_code"), Some(Json::number(1.0)))
        }
        _ => assert_true(false)
      }
    }
    _ => assert_true(false)
  }
}
