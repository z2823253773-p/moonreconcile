const initial = () => ({ left_import_id: null, right_import_id: null, config_asset_id: null, config: null, draft_dirty: false, revision: null, stale: false, pending_decisions: [], active_job: null, error: null });

export function createWorkbenchState() {
  let value = initial();
  let sourceRuleGeneration = 0;
  const listeners = new Set();
  return {
    get: () => value,
    update(patch) {
      const touchesSourceOrRules = ['left_import_id', 'right_import_id', 'config'].some((key) => Object.hasOwn(patch, key) && patch[key] !== value[key]);
      const validatedBinding = Boolean(patch.config_asset_id && patch.config && patch.draft_dirty === false);
      value = { ...value, ...patch };
      if (touchesSourceOrRules) {
        sourceRuleGeneration++;
        value = { ...value, stale: true, config_asset_id: validatedBinding ? patch.config_asset_id : null, pending_decisions: [] };
      }
      for (const listener of listeners) listener(value);
    },
    invalidateRules(patch = {}) {
      sourceRuleGeneration++;
      value = { ...value, ...patch, draft_dirty: true, config_asset_id: null, stale: true, pending_decisions: [] };
      for (const listener of listeners) listener(value);
    },
    reset() { value = initial(); sourceRuleGeneration++; for (const listener of listeners) listener(value); },
    generation: () => sourceRuleGeneration,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
