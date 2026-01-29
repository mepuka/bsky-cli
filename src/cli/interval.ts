import { Duration, Effect, Option } from "effect";
import { CliInputError } from "./errors.js";

const parseDurationText = (value: string) =>
  Effect.try({
    try: () => Duration.decode(value as Duration.DurationInput),
    catch: (cause) =>
      CliInputError.make({
        message: `Invalid duration: ${value}. Use formats like "30 seconds" or "500 millis".`,
        cause
      })
  }).pipe(
    Effect.flatMap((duration) =>
      Duration.toMillis(duration) < 0
        ? Effect.fail(
            CliInputError.make({
              message: "Interval must be non-negative.",
              cause: duration
            })
          )
        : Effect.succeed(duration)
    )
  );

export const parseInterval = (interval: Option.Option<string>) =>
  Option.match(interval, {
    onSome: parseDurationText,
    onNone: () => Effect.succeed(Duration.seconds(30))
  });

export const parseOptionalDuration = (value: Option.Option<string>) =>
  Option.match(value, {
    onSome: (raw) => parseDurationText(raw).pipe(Effect.map(Option.some)),
    onNone: () => Effect.succeed(Option.none())
  });
