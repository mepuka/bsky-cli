import * as Doc from "@effect/printer/Doc";
import { pipe } from "effect/Function";
import type { Annotation } from "./annotation.js";
import { renderAnsi, renderPlain } from "./render.js";
import { ann, label, value } from "./primitives.js";
import { displayWidth } from "../../domain/text-width.js";

export type SDoc = Doc.Doc<Annotation>;

export interface TableColumn {
  readonly header: string;
  readonly width?: number;
}

export interface TableConfig {
  readonly columns: ReadonlyArray<TableColumn>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly trimEnd?: boolean;
}

export const calculateColumnWidths = (
  columns: ReadonlyArray<TableColumn>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<number> => {
  return columns.map((column, index) => {
    const contentWidths = rows.map((row) => displayWidth(row[index] ?? ""));
    return Math.max(displayWidth(column.header), ...contentWidths);
  });
};

export const buildCell = (
  content: string,
  width: number,
  style?: "label" | "value" | "dim"
): SDoc => {
  const doc = style === "label" 
    ? label(content) 
    : style === "dim" 
      ? ann("dim", Doc.text(content))
      : value(content);
  
  return pipe(doc, Doc.fillBreak(width));
};

export const buildRow = (
  cells: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
  styles?: ReadonlyArray<"label" | "value" | "dim" | undefined>,
  trimEnd = false
): SDoc => {
  const cellDocs = cells.map((cell, i) => {
    const style = styles?.[i];
    return buildCell(cell, widths[i] ?? 0, style);
  });
  
  const row = Doc.hsep(cellDocs);
  
  if (trimEnd) {
    return pipe(
      row,
      Doc.render({ style: "pretty" }),
      (str: string) => str.trimEnd(),
      Doc.text
    );
  }
  
  return row;
};

export const buildTableDoc = (config: TableConfig): SDoc => {
  const { columns, rows, trimEnd = false } = config;
  
  const widths = calculateColumnWidths(columns, rows);
  
  const headerCells = columns.map((col, i) => 
    buildCell(col.header, widths[i] ?? 0, "label")
  );
  const header = Doc.hsep(headerCells);
  
  const separatorCells = widths.map((w) => ann("dim", Doc.text("-".repeat(w))));
  const separator = Doc.hsep(separatorCells);
  
  const dataRows = rows.map((row) => {
    const dataCells = row.map((cell, i) => buildCell(cell, widths[i] ?? 0, "value"));
    const dataRow = Doc.hsep(dataCells);
    
    if (trimEnd) {
      return pipe(
        dataRow,
        Doc.render({ style: "pretty" }),
        (str: string) => str.trimEnd(),
        Doc.text
      );
    }
    
    return dataRow;
  });
  
  return Doc.vsep([header, separator, ...dataRows]);
};

export const renderTable = (config: TableConfig, ansi = false): string => {
  const doc = buildTableDoc(config);
  return ansi ? renderAnsi(doc) : renderPlain(doc);
};

export const renderTableLegacy = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  trimEnd = true
): string => {
  const columns = headers.map((header) => ({ header }));
  return renderTable({ columns, rows, trimEnd });
};
