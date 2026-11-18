/**
 * A `$state`-backed stand-in for the Models store's list and default, for a
 * mocked `createModels()` whose getters must be reactive (#1123 R1.6: the
 * Settings line is a `$derived` over the store facade, never a value
 * captured at mount, and a test changes the pose after mount to prove it).
 */
export const modelsPose = $state<{
  models: Array<Record<string, unknown>>;
  defaultModelId: string | null;
}>({ models: [], defaultModelId: null });
