import { Console, Effect, Stream } from "effect";

const jsonLine = (value: unknown, pretty?: boolean) =>
  JSON.stringify(value, null, pretty ? 2 : 0);

export const writeJson = (value: unknown, pretty?: boolean) =>
  Console.log(jsonLine(value, pretty));

export const writeText = (value: string) => Console.log(value);

export const writeJsonStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>
): Effect.Effect<void, E, R> =>
  stream.pipe(Stream.runForEach((value) => Console.log(jsonLine(value))));
