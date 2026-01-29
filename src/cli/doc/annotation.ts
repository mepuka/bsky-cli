import * as Ansi from "@effect/printer-ansi/Ansi";

export type Annotation =
  | "label" | "value" | "dim" | "accent" | "muted" | "connector"
  | "error" | "warning" | "metric" | "badge"
  | "storeName" | "storeName:root" | "storeName:derived"
  | "status:ready" | "status:stale" | "status:unknown" | "status:source"
  | "sync:current" | "sync:stale" | "sync:empty" | "sync:unknown"
  | "author" | "hashtag" | "link" | "timestamp" | "embed" | "cycle";

export const toAnsi = (a: Annotation): Ansi.Ansi => {
  switch (a) {
    case "label": case "dim": case "muted": case "connector": return Ansi.blackBright;
    case "value": return Ansi.white;
    case "storeName": return Ansi.cyan;
    case "storeName:root": return Ansi.combine(Ansi.cyan, Ansi.bold);
    case "storeName:derived": return Ansi.magenta;
    case "status:ready": return Ansi.green;
    case "status:stale": return Ansi.red;
    case "status:unknown": return Ansi.yellow;
    case "status:source": return Ansi.cyan;
    case "sync:current": return Ansi.green;
    case "sync:stale": case "sync:unknown": return Ansi.yellow;
    case "sync:empty": return Ansi.blackBright;
    case "accent": return Ansi.cyan;
    case "error": return Ansi.red;
    case "warning": case "cycle": return Ansi.yellow;
    case "metric": return Ansi.whiteBright;
    case "badge": return Ansi.bold;
    case "author": return Ansi.combine(Ansi.cyan, Ansi.bold);
    case "hashtag": return Ansi.blue;
    case "link": return Ansi.underlined;
    case "timestamp": return Ansi.blackBright;
    case "embed": return Ansi.magenta;
  }
};
