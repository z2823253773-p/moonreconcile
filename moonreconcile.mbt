///|
/// Package entry point.
///
/// The public contract lives in `engine.mbt`: `invoke(request_json : String)`
/// is the single JSON-in/JSON-out function the Node adapter calls. This file
/// holds no logic so that dispatch, validation and future algorithm code stay
/// inside testable files.
