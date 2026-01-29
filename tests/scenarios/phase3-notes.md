# Phase 3 Notes — Saved Filters

**Date:** 2026-01-29

## Results

- 9 filters created successfully
- `filter validate-all` reports 9/9 OK
- `filter list` returns sorted array of names
- `filter describe --ansi` renders styled Doc output with breakdown, compatibility, cost
- `filter describe --format json` returns structured JSON

## Bugs

### BUG-P3-1: Regex parser fails on spaces inside patterns (Medium)

**Observed:** `regex:/red card|yellow card/i` fails with `Unexpected token "card|yellow"`. The parser treats the space after "red" as a token boundary, breaking out of the regex literal.

**Similarly:** `regex:/come on|inject/i` fails — space after "come" breaks parsing.

**Workaround:** Remove patterns with spaces, use only single-word alternations.

**Expected:** Regex patterns between `/` delimiters should allow any characters including spaces. The parser should only end the regex at the closing `/` + flags.

**Impact:** Cannot create filters for multi-word phrases in regex. Users must fall back to `contains` for phrases, losing regex features like alternation and case-insensitive matching.

### BUG-P3-2: Regex parser fails on parenthesized groups (Medium)

**Observed:** `regex:/\b(Saka|Rice)\b/i` fails with `Unexpected token "("`. Parser treats `(` as filter DSL grouping rather than regex grouping.

**Workaround:** Omit word boundary groups: `regex:/Saka|Rice/i` works.

**Expected:** Inside regex delimiters, parentheses should be part of the regex, not the filter DSL.

**Impact:** Cannot use regex groups, word boundaries with groups, or capture groups. Reduces regex filtering to simple alternation and character classes.

## UX Observations

### UX-P3-1: `filter list` output is bare JSON array

The output is `["arsenal-core","arsenal-emotions",...]` — a raw JSON array of strings. For a CLI user, a formatted list with filter expressions would be more useful:

```
arsenal-core       hashtag:#Arsenal OR hashtag:#AFC OR ...
arsenal-emotions   regex:/COYG|inject|.../i AND hashtag:#Arsenal
arsenal-goals      (hashtag:#Arsenal OR ...) AND (contains:"goal" OR ...)
```

### UX-P3-2: `filter create` gives minimal confirmation

Output is `{"name":"arsenal-core","saved":true}`. A human-friendly message like `Filter "arsenal-core" saved.` with the expression echoed back would be better. The JSON is fine for scripting but not for interactive use.

### UX-P3-3: `filter describe --ansi` works well

The Doc-based rendering is clear: summary line, breakdown, compatibility matrix, cost/complexity. ANSI colors help distinguish labels from values. This is one of the better CLI outputs.

### UX-P3-4: No `filter edit` or `filter show` command

To see what expression a filter uses, you must `filter describe`. There's no quick way to see just the raw expression, or to edit an existing filter. Users would need to `filter delete` + `filter create` to modify.

## What Worked Well

- Filter DSL handles complex boolean expressions cleanly
- `validate-all` is a useful batch check
- Describe with `--ansi` and `--format json` both work
- Saved filter names work as `@name` references in queries
