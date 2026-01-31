import { Chunk, Effect, Option, Order, Stream } from "effect";

export const mergeOrderedStreams = <A, E, R>(
  streams: ReadonlyArray<Stream.Stream<A, E, R>>,
  order: Order.Order<A>
): Stream.Stream<A, E, R> => {
  if (streams.length === 0) {
    return Stream.empty;
  }

  return Stream.unwrapScoped(
    Effect.gen(function* () {
      const pulls = yield* Effect.forEach(streams, (stream) => Stream.toPull(stream), {
        discard: false
      });

      const buffers: Array<ReadonlyArray<A>> = pulls.map(() => []);
      const indices: number[] = pulls.map(() => 0);
      const heads: Array<A | undefined> = pulls.map(() => undefined);
      let active = pulls.length;

      const pullChunk = (index: number) =>
        pulls[index]!.pipe(
          Effect.map(Option.some),
          Effect.catchAll((cause) =>
            Option.match(cause, {
              onNone: () => Effect.succeed(Option.none()),
              onSome: (error) => Effect.fail(error)
            })
          )
        );

      const nextValue = (index: number): Effect.Effect<Option.Option<A>, E, R> =>
        Effect.gen(function* () {
          while (true) {
            const buffer = buffers[index] ?? [];
            const position = indices[index] ?? 0;
            if (position < buffer.length) {
              const value = buffer[position]!;
              indices[index] = position + 1;
              return Option.some(value);
            }

            const nextChunkOption = yield* pullChunk(index);
            if (Option.isNone(nextChunkOption)) {
              return Option.none<A>();
            }
            const nextChunk = Chunk.toReadonlyArray(nextChunkOption.value);
            if (nextChunk.length === 0) {
              continue;
            }
            buffers[index] = nextChunk;
            indices[index] = 1;
            return Option.some(nextChunk[0]!);
          }
        });

      for (let index = 0; index < pulls.length; index += 1) {
        const next = yield* nextValue(index);
        if (Option.isNone(next)) {
          active -= 1;
          heads[index] = undefined;
        } else {
          heads[index] = next.value;
        }
      }

      const pull: Effect.Effect<Chunk.Chunk<A>, Option.Option<E>, R> =
        Effect.gen(function* () {
          if (active === 0) {
            return yield* Effect.fail(Option.none<E>());
          }

          let selectedIndex = -1;
          let selectedValue: A | undefined;
          for (let index = 0; index < heads.length; index += 1) {
            const value = heads[index];
            if (value === undefined) continue;
            if (selectedIndex < 0 || order(value, selectedValue as A) < 0) {
              selectedIndex = index;
              selectedValue = value;
            }
          }

          if (selectedIndex < 0 || selectedValue === undefined) {
            return yield* Effect.fail(Option.none<E>());
          }

          const next = yield* nextValue(selectedIndex).pipe(
            Effect.mapError(Option.some)
          );
          if (Option.isNone(next)) {
            heads[selectedIndex] = undefined;
            active -= 1;
          } else {
            heads[selectedIndex] = next.value;
          }

          return Chunk.of(selectedValue);
        });

      return Stream.fromPull(Effect.succeed(pull));
    })
  );
};
