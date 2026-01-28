import type { FilterExpr } from "./filter.js";

export type FilterExplanation = {
  readonly _tag: FilterExpr["_tag"];
  readonly ok: boolean;
  readonly detail?: string;
  readonly skipped?: boolean;
  readonly children?: ReadonlyArray<FilterExplanation>;
};
