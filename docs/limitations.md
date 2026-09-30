# Validation limitations

- Every example and benchmark input in Task 7 is synthetic. The adversarial catalog truth set contains one true pair and one false competitor; its rates have no population meaning.
- The independent exact-join-plus-rules reference is narrowly scoped to these fixtures. It is not a general comparator, fuzzy linker, benchmark of a third-party product, or substitute for independent production validation.
- No actual orders, migration, or supplier workflow was observed. Typical file sizes, current manual time, error costs, and decision burden remain unknown.
- XLSX input and Excel-specific behavior remain unverified. CSV works as the current CLI input; whether it is sufficient for a real user's source export is unknown.
- Benchmarks cover only listed deterministic local cases and one machine/toolchain. They do not establish behavior for all inputs, machine sizes, operating systems, or 100000-row files. Initial configured resource limits are guardrails, not supported-capacity claims.
- Candidate score is not a probability or calibrated confidence. Suggestions require human acceptance; blocking rules can exclude true pairs. The selected assignment can be wrong, as the synthetic catalog case intentionally shows.
- Documentation review does not prove a capability gap against MoonRow, DataComPy, Record Linkage Toolkit, or other software. No competitor comparison run or real-workflow benefit has been established.
- Test completion, a local package check, CI status, release publication, contest acceptance, and user value are separate claims. This milestone demonstrates local synthetic execution only.
