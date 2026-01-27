import type { Applicative } from "@effect/typeclass/Applicative";
import { getApplicative, type ConcurrencyOptions } from "@effect/typeclass/data/Effect";
import type * as Filterable from "@effect/typeclass/Filterable";
import type * as Traversable from "@effect/typeclass/Traversable";
import type * as TraversableFilterable from "@effect/typeclass/TraversableFilterable";
import { Chunk, Effect, Option } from "effect";
import type { ChunkTypeLambda } from "effect/Chunk";
import { dual } from "effect/Function";
import type { Kind, TypeLambda } from "effect/HKT";
import type { Either } from "effect/Either";

export const ChunkFilterable: Filterable.Filterable<ChunkTypeLambda> = {
  partitionMap: Chunk.partitionMap,
  filterMap: Chunk.filterMap
};

const traverse = <F extends TypeLambda>(F: Applicative<F>) =>
  dual(
    2,
    <A, R, O, E, B>(
      self: Chunk.Chunk<A>,
      f: (a: A) => Kind<F, R, O, E, B>
    ): Kind<F, R, O, E, Chunk.Chunk<B>> =>
      F.map(
        F.productAll(Chunk.toReadonlyArray(self).map(f)),
        Chunk.fromIterable
      )
  );

export const ChunkTraversable: Traversable.Traversable<ChunkTypeLambda> = {
  traverse
};

const traversePartitionMap = <F extends TypeLambda>(F: Applicative<F>) =>
  dual(
    2,
    <A, R, O, E, B, C>(
      self: Chunk.Chunk<A>,
      f: (a: A) => Kind<F, R, O, E, Either<C, B>>
    ): Kind<F, R, O, E, [Chunk.Chunk<B>, Chunk.Chunk<C>]> =>
      F.map(
        traverse(F)(self, f) as Kind<F, R, O, E, Chunk.Chunk<Either<C, B>>>,
        (chunk) => Chunk.separate(chunk)
      )
  );

const traverseFilterMap = <F extends TypeLambda>(F: Applicative<F>) =>
  dual(
    2,
    <A, R, O, E, B>(
      self: Chunk.Chunk<A>,
      f: (a: A) => Kind<F, R, O, E, Option.Option<B>>
    ): Kind<F, R, O, E, Chunk.Chunk<B>> =>
      F.map(
        traverse(F)(self, f) as Kind<F, R, O, E, Chunk.Chunk<Option.Option<B>>>,
        (chunk) => Chunk.compact(chunk)
      )
  );

export const ChunkTraversableFilterable: TraversableFilterable.TraversableFilterable<ChunkTypeLambda> = {
  traversePartitionMap,
  traverseFilterMap
};

export const traverseFilterEffect = <A, E, R>(
  items: Chunk.Chunk<A>,
  predicate: (item: A) => Effect.Effect<boolean, E, R>,
  options?: ConcurrencyOptions
): Effect.Effect<Chunk.Chunk<A>, E, R> =>
  ChunkTraversableFilterable.traverseFilterMap(getApplicative(options))(
    items,
    (item) =>
      Effect.map(predicate(item), (keep) =>
        keep ? Option.some(item) : Option.none()
      )
  );

export const filterByFlags = <A>(
  items: Chunk.Chunk<A>,
  flags: Chunk.Chunk<boolean>
): Chunk.Chunk<A> =>
  ChunkFilterable.filterMap(Chunk.zip(items, flags), (tuple) =>
    tuple[1] ? Option.some(tuple[0]) : Option.none()
  );
