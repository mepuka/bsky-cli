const emojiRegex = (() => {
  try {
    return new RegExp("\\p{Extended_Pictographic}", "u");
  } catch {
    return undefined;
  }
})();

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

const toGraphemes = (text: string) =>
  segmenter
    ? Array.from(segmenter.segment(text), (part) => part.segment)
    : Array.from(text);

const isFullwidthCodePoint = (codePoint: number) =>
  codePoint >= 0x1100 &&
  (codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd));

export const displayWidth = (text: string) => {
  let width = 0;
  for (const grapheme of toGraphemes(text)) {
    if (grapheme.length === 0) {
      continue;
    }
    const codePoint = grapheme.codePointAt(0) ?? 0;
    const isWide =
      (emojiRegex ? emojiRegex.test(grapheme) : false) ||
      isFullwidthCodePoint(codePoint);
    width += isWide ? 2 : 1;
  }
  return width;
};

export const padEndDisplay = (text: string, targetWidth: number) => {
  const width = displayWidth(text);
  if (width >= targetWidth) {
    return text;
  }
  return `${text}${" ".repeat(targetWidth - width)}`;
};
