import * as Doc from "@effect/printer/Doc";
import { pipe } from "effect/Function";
import type { Annotation } from "./annotation.js";

type SDoc = Doc.Doc<Annotation>;

export const ann = (a: Annotation, doc: SDoc): SDoc => Doc.annotate(doc, a);

export const label = (text: string): SDoc => ann("label", Doc.text(text));
export const value = (text: string): SDoc => ann("value", Doc.text(text));

export const field = (key: string, val: string, keyWidth?: number): SDoc =>
  Doc.hsep([
    keyWidth ? pipe(label(key + ":"), Doc.fillBreak(keyWidth)) : label(key + ":"),
    value(val)
  ]);

export const badge = (text: string, annotation: Annotation): SDoc =>
  ann(annotation, Doc.text(`[${text}]`));

export const connector = (text: string): SDoc =>
  ann("connector", Doc.text(text));

export const metric = (icon: string, count: number): SDoc =>
  ann("metric", Doc.text(`${icon} ${new Intl.NumberFormat("en-US").format(count)}`));
