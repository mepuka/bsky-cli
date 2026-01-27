export const withExamples = (
  description: string,
  examples: ReadonlyArray<string>,
  notes: ReadonlyArray<string> = []
) => {
  const lines = [description];
  if (notes.length > 0) {
    lines.push("", ...notes);
  }
  if (examples.length > 0) {
    lines.push("", "Examples:", ...examples.map((example) => `  ${example}`));
  }
  return lines.join("\n");
};
