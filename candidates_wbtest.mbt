///|
test "task4_candidate_all_pairs_fixed_denominator_and_pending_suggestion" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"a\",\"right\":\"a\",\"type\":\"text\"},{\"name\":\"b\",\"left\":\"b\",\"right\":\"b\",\"type\":\"text\"}],\"key\":[],\"candidates\":{\"fields\":[{\"field\":\"a\",\"metric\":\"exact\",\"weight\":1},{\"field\":\"b\",\"metric\":\"exact\",\"weight\":3}],\"threshold\":2500}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let result = compare_tables(
    { headers: ["a", "b"], rows: [["x", "u"]], },
    { headers: ["a", "b"], rows: [["x", "v"]], },
    config,
  )
  assert_eq(result.status, "complete")
  assert_eq(result.exit_code, 1)
  let json = result_to_json(result).stringify()
  assert_true(json.contains("\"score\":2500"))
  assert_true(json.contains("\"suggested\":true"))
  assert_true(json.contains("\"status\":\"pending_review\""))
  assert_true(json.contains("\"candidate_count\":1"))
}

///|
test "task4_assignment_max_weight_partial_not_greedy" {
  let pairs = solve_assignment(2, 2, [
    { left: 0, right: 0, weight: 9000, },
    { left: 0, right: 1, weight: 8000, },
    { left: 1, right: 0, weight: 8000, },
  ])
  assert_eq(pairs.length(), 2)
  assert_eq(pairs[0].left + pairs[1].left, 1)
  assert_eq(pairs[0].right + pairs[1].right, 1)
  assert_eq(pairs[0].weight + pairs[1].weight, 16000)
}

///|
test "task4_blocking_or_and_deduplicates_pairs_and_ignores_missing_keys" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"a\",\"left\":\"a\",\"right\":\"a\",\"type\":\"text\"},{\"name\":\"b\",\"left\":\"b\",\"right\":\"b\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"a\",\"metric\":\"exact\",\"weight\":1}],\"threshold\":1,\"blocking\":[[\"a\"],[\"b\"]]}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let stage = generate_candidates_with_budget(
    { headers: ["a", "b"], rows: [["x", "k"], ["y", "m"], ["", "z"]], },
    { headers: ["a", "b"], rows: [["x", "k"], ["y", "n"], ["q", "z"]], },
    [1, 2, 3],
    [1, 2, 3],
    config,
    {
      pairs: 9,
      edit_cells: 100,
      max_component_side: 10,
      max_edit_codepoints: 512,
    },
  )
  assert_eq(stage.candidates.length(), 3)
  assert_eq(stage.issues.length(), 0)
  let rendered = Json::array(stage.candidates).stringify()
  assert_true(rendered.contains("\"left_id\":\"L1\",\"right_id\":\"R1\""))
  assert_true(rendered.contains("\"left_id\":\"L2\",\"right_id\":\"R2\""))
  assert_true(rendered.contains("\"left_id\":\"L3\",\"right_id\":\"R3\""))
}

///|
test "task4_pair_budget_overflow_is_transactional_and_exact_pairs_survive" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"id\",\"left\":\"id\",\"right\":\"id\",\"type\":\"text\"},{\"name\":\"name\",\"left\":\"name\",\"right\":\"name\",\"type\":\"text\"}],\"key\":[\"id\"],\"candidates\":{\"fields\":[{\"field\":\"name\",\"metric\":\"exact\",\"weight\":1}],\"threshold\":1}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let left = {
    headers: ["id", "name"],
    rows: [["exact", "ok"], ["l1", "a"], ["l2", "b"]],
  }
  let right = {
    headers: ["id", "name"],
    rows: [["exact", "ok"], ["r1", "a"], ["r2", "b"]],
  }
  let stage = generate_candidates_with_budget(
    left,
    right,
    [2, 3],
    [2, 3],
    config,
    {
      pairs: 3,
      edit_cells: 100,
      max_component_side: 10,
      max_edit_codepoints: 512,
    },
  )
  assert_eq(stage.candidates.length(), 0)
  assert_eq(stage.issues.length(), 1)
  assert_eq(stage.unprocessed_left, [2, 3])
  assert_eq(stage.unprocessed_right, [2, 3])
  let result = compare_tables_with_budget(left, right, config, {
    pairs: 3,
    edit_cells: 100,
    max_component_side: 10,
    max_edit_codepoints: 512,
  })
  assert_eq(result.pairs.length(), 1)
  assert_eq(result.status, "incomplete")
  assert_eq(result.exit_code, 3)
  assert_eq(result.unprocessed_left_records, [2, 3])
  let report = result_to_json(result).stringify()
  assert_true(report.contains("\"status\":\"unprocessed\""))
  assert_true(report.contains("\"unprocessed\":2"))
  assert_true(report.contains("\"candidate_count\":0"))
}

///|
test "task4_edit_score_uses_unicode_codepoints_and_invalid_typed_score_is_null" {
  assert_eq(edit_similarity("猫", "猫狗"), 5000)
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"amount\",\"left\":\"amount\",\"right\":\"amount\",\"type\":\"decimal\"}],\"candidates\":{\"fields\":[{\"field\":\"amount\",\"metric\":\"decimal\",\"weight\":1}],\"threshold\":1}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let result = compare_tables(
    { headers: ["amount"], rows: [["NaN"]], },
    { headers: ["amount"], rows: [["1"]], },
    config,
  )
  let json = result_to_json(result).stringify()
  assert_true(json.contains("\"score\":null"))
  assert_true(json.contains("invalid_identity_value"))
  assert_true(!json.contains("\"suggested\":true"))
}

///|
test "task4_qualified_component_limit_does_not_apply_to_pre_score_graph" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"name\",\"left\":\"name\",\"right\":\"name\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"name\",\"metric\":\"exact\",\"weight\":1}],\"threshold\":1}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let left = { headers: ["name"], rows: [["same"], ["same"]], }
  let right = { headers: ["name"], rows: [["same"], ["same"]], }
  let stage = generate_candidates_with_budget(
    left,
    right,
    [1, 2],
    [1, 2],
    config,
    {
      pairs: 4,
      edit_cells: 100,
      max_component_side: 1,
      max_edit_codepoints: 512,
    },
  )
  assert_eq(stage.candidates.length(), 4)
  assert_eq(stage.issues.length(), 1)
  assert_eq(stage.unprocessed_left, [1, 2])
  assert_eq(stage.unprocessed_right, [1, 2])
  assert_true(
    Json::array(stage.candidates)
    .stringify()
    .contains("\"component_id\":\"Q1\""),
  )
}

///|
test "task4_scoring_admission_is_component_atomic_and_budget_remains_for_later_work" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"block\",\"left\":\"block\",\"right\":\"block\",\"type\":\"text\"},{\"name\":\"name\",\"left\":\"name\",\"right\":\"name\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"name\",\"metric\":\"edit\",\"weight\":1}],\"threshold\":1,\"blocking\":[[\"block\"]]}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let left = { headers: ["block", "name"], rows: [["a", "cat"], ["b", "z"]], }
  let right = { headers: ["block", "name"], rows: [["a", "cat"], ["b", "z"]], }
  let stage = generate_candidates_with_budget(
    left,
    right,
    [1, 2],
    [1, 2],
    config,
    { pairs: 2, edit_cells: 1, max_component_side: 10, max_edit_codepoints: 2, },
  )
  assert_eq(stage.candidates.length(), 2)
  assert_eq(stage.issues.length(), 1)
  assert_eq(stage.unprocessed_left, [1])
  assert_eq(stage.unprocessed_right, [1])
  let rendered = Json::array(stage.candidates).stringify()
  assert_true(rendered.contains("\"component_id\":\"P1\""))
  assert_true(rendered.contains("\"component_id\":\"Q1\""))
  assert_true(
    rendered.contains("\"left_id\":\"L1\",\"right_id\":\"R1\",\"score\":null"),
  )
  assert_true(
    rendered.contains("\"left_id\":\"L2\",\"right_id\":\"R2\",\"score\":10000"),
  )
}

///|
test "task4_edit_codepoint_limit_513_marks_whole_component_unprocessed" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"name\",\"left\":\"name\",\"right\":\"name\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"name\",\"metric\":\"edit\",\"weight\":1}],\"threshold\":1}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let long = String::from_array(Array::make(513, 'x'))
  let stage = generate_candidates_with_budget(
    { headers: ["name"], rows: [[long]], },
    { headers: ["name"], rows: [[long]], },
    [1],
    [1],
    config,
    {
      pairs: 1,
      edit_cells: 300000,
      max_component_side: 10,
      max_edit_codepoints: 512,
    },
  )
  assert_eq(stage.candidates.length(), 1)
  assert_eq(stage.issues.length(), 1)
  assert_eq(stage.unprocessed_left, [1])
  assert_eq(stage.unprocessed_right, [1])
  assert_true(
    Json::array(stage.candidates).stringify().contains("component_unprocessed"),
  )
}

///|
test "task4_assignment_leaves_rows_unmatched_and_prefers_total_weight" {
  let high = solve_assignment(2, 2, [
    { left: 0, right: 0, weight: 10000, },
    { left: 0, right: 1, weight: 4000, },
    { left: 1, right: 0, weight: 4000, },
  ])
  assert_eq(high.length(), 1)
  assert_eq(high[0].weight, 10000)
  assert_eq(solve_assignment(2, 2, []).length(), 0)
  let unequal = solve_assignment(1, 3, [{ left: 0, right: 2, weight: 7000, }])
  assert_eq(unequal.length(), 1)
  assert_eq(unequal[0].right, 2)
}

///|
test "task4_256_max_weight_fields_use_wide_aggregate_arithmetic" {
  let field_configs : Array[Json] = []
  let candidate_fields : Array[Json] = []
  let headers : Array[String] = []
  let values : Array[String] = []
  for i in 0..<256 {
    let name = "f\{i}"
    headers.push(name)
    values.push("identical")
    field_configs.push(
      Json::object({
        "name": Json::string(name),
        "left": Json::string(name),
        "right": Json::string(name),
        "type": Json::string("text"),
      }),
    )
    candidate_fields.push(
      Json::object({
        "field": Json::string(name),
        "metric": Json::string("exact"),
        "weight": Json::number(10000.0),
      }),
    )
  }
  let config_json = Json::object({
    "schema_version": Json::number(1.0),
    "fields": Json::array(field_configs),
    "candidates": Json::object({
      "fields": Json::array(candidate_fields),
      "threshold": Json::number(10000.0),
    }),
  })
  let config = match parse_config(config_json) {
    Ok(value) => value
    Err(_) => abort("256-field candidate fixture invalid")
  }
  let result = compare_tables(
    { headers, rows: [values], },
    { headers, rows: [values], },
    config,
  )
  assert_eq(result.candidates.length(), 1)
  assert_true(
    Json::array(result.candidates).stringify().contains("\"score\":10000"),
  )
  assert_true(
    Json::array(result.candidates).stringify().contains("\"suggested\":true"),
  )
}

///|
test "task4_edit_cell_budget_exact_boundary_succeeds_and_one_over_fails" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"name\",\"left\":\"name\",\"right\":\"name\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"name\",\"metric\":\"edit\",\"weight\":1}],\"threshold\":1}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let text = String::from_array(Array::make(512, 'x'))
  let left = { headers: ["name"], rows: [[text]], }
  let right = { headers: ["name"], rows: [[text]], }
  let exact = generate_candidates_with_budget(left, right, [1], [1], config, {
    pairs: 1,
    edit_cells: 512 * 512,
    max_component_side: 10,
    max_edit_codepoints: 512,
  })
  assert_eq(exact.issues.length(), 0)
  assert_true(
    Json::array(exact.candidates).stringify().contains("\"score\":10000"),
  )
  let over = generate_candidates_with_budget(left, right, [1], [1], config, {
    pairs: 1,
    edit_cells: 512 * 512 - 1,
    max_component_side: 10,
    max_edit_codepoints: 512,
  })
  assert_eq(over.issues.length(), 1)
  assert_eq(over.unprocessed_left, [1])
  assert_eq(over.unprocessed_right, [1])
}

///|
test "task4_qualified_size_limit_is_per_component_and_exact_limit_succeeds" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"block\",\"left\":\"block\",\"right\":\"block\",\"type\":\"text\"},{\"name\":\"name\",\"left\":\"name\",\"right\":\"name\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"name\",\"metric\":\"exact\",\"weight\":1}],\"threshold\":1,\"blocking\":[[\"block\"]]}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let left = {
    headers: ["block", "name"],
    rows: [["a", "x"], ["a", "x"], ["b", "y"]],
  }
  let right = { headers: ["block", "name"], rows: [["a", "x"], ["b", "y"]], }
  let stage = generate_candidates_with_budget(
    left,
    right,
    [1, 2, 3],
    [1, 2],
    config,
    {
      pairs: 3,
      edit_cells: 100,
      max_component_side: 1,
      max_edit_codepoints: 512,
    },
  )
  assert_eq(stage.candidates.length(), 3)
  assert_eq(stage.issues.length(), 1)
  assert_eq(stage.unprocessed_left, [1, 2])
  assert_eq(stage.unprocessed_right, [1])
  let rendered = Json::array(stage.candidates).stringify()
  assert_true(rendered.contains("\"left_id\":\"L3\",\"right_id\":\"R2\""))
  assert_true(
    rendered.contains(
      "\"left_id\":\"L3\",\"right_id\":\"R2\",\"score\":10000,\"field_scores\":[{\"field\":\"name\",\"metric\":\"exact\",\"weight\":1,\"score\":10000}],\"diagnostics\":[],\"suggested\":true,\"component_id\":\"Q2\"",
    ),
  )
  let exact_limit = generate_candidates_with_budget(
    left,
    right,
    [3],
    [2],
    config,
    {
      pairs: 1,
      edit_cells: 100,
      max_component_side: 1,
      max_edit_codepoints: 512,
    },
  )
  assert_eq(exact_limit.issues.length(), 0)
  assert_eq(exact_limit.candidates.length(), 1)
  assert_true(
    Json::array(exact_limit.candidates)
    .stringify()
    .contains("\"suggested\":true"),
  )
}

///|
test "task4_records_outside_blocking_coverage_remain_pending_with_explanation" {
  let config = match
    parse_config(
      @json.parse(
        "{\"schema_version\":1,\"fields\":[{\"name\":\"block\",\"left\":\"block\",\"right\":\"block\",\"type\":\"text\"},{\"name\":\"name\",\"left\":\"name\",\"right\":\"name\",\"type\":\"text\"}],\"candidates\":{\"fields\":[{\"field\":\"name\",\"metric\":\"exact\",\"weight\":1}],\"threshold\":1,\"blocking\":[[\"block\"]]}}",
      ),
    ) {
    Ok(value) => value
    Err(_) => abort("candidate fixture invalid")
  }
  let result = compare_tables(
    { headers: ["block", "name"], rows: [["", "x"]], },
    { headers: ["block", "name"], rows: [["a", "x"]], },
    config,
  )
  assert_eq(result.candidates.length(), 0)
  assert_eq(result.status, "complete")
  assert_eq(result.exit_code, 1)
  let report = result_to_json(result).stringify()
  assert_true(report.contains("candidate_blocking_uncovered"))
  assert_true(report.contains("no configured blocking group matched"))
  assert_true(report.contains("\"status\":\"pending_review\""))
  assert_true(report.contains("\"unprocessed\":0"))
}
