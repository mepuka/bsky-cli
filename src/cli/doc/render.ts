import * as Doc from "@effect/printer/Doc";
import * as AnsiDoc from "@effect/printer-ansi/AnsiDoc";
import type { Annotation } from "./annotation.js";
import { toAnsi } from "./annotation.js";

export const renderPlain = (doc: Doc.Doc<Annotation>, width?: number): string => {
  const plain = Doc.unAnnotate(doc);
  return width
    ? Doc.render(plain, { style: "pretty", options: { lineWidth: width } })
    : Doc.render(plain, { style: "pretty" });
};

export const renderAnsi = (doc: Doc.Doc<Annotation>, width?: number): string => {
  const ansiDoc = Doc.reAnnotate(doc, toAnsi);
  return width
    ? AnsiDoc.render(ansiDoc, { style: "pretty", options: { lineWidth: width } })
    : AnsiDoc.render(ansiDoc, { style: "pretty" });
};
