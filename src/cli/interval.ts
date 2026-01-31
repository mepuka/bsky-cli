import { Duration, Option } from "effect";

export const parseInterval = (interval: Option.Option<Duration.Duration>) =>
  Option.getOrElse(interval, () => Duration.seconds(30));

export const parseOptionalDuration = (value: Option.Option<Duration.Duration>) => value;
