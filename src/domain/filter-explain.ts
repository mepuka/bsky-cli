import type { FilterExpr } from "./filter.js";
import type { LlmDecisionMeta } from "./llm.js";

export type FilterExplanation = {
  readonly _tag: FilterExpr["_tag"];
  readonly ok: boolean;
  readonly detail?: string;
  readonly skipped?: boolean;
  readonly children?: ReadonlyArray<FilterExplanation>;
  readonly llm?: LlmDecisionMeta;
};
