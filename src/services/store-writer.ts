import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Context, Effect, Layer, Option, Random, Ref, Schema } from "effect";
import { StoreIoError } from "../domain/errors.js";
import { PostEvent, PostEventRecord } from "../domain/events.js";
import { EventId } from "../domain/primitives.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { storePrefix } from "./store-keys.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIME = 0xffff_ffff_ffff;

const encodeTime = (time: number) => {
  if (!Number.isFinite(time) || time < 0 || time > MAX_ULID_TIME) {
    throw new Error(`ULID time out of range: ${time}`);
  }

  let value = BigInt(Math.trunc(time));
  let output = "";
  for (let i = 0; i < 10; i += 1) {
    const mod = Number(value % 32n);
    output = `${ULID_ALPHABET[mod]}${output}`;
    value = value / 32n;
  }
  return output;
};

const encodeRandomDigits = (digits: ReadonlyArray<number>) =>
  digits.map((digit) => ULID_ALPHABET[digit]).join("");

const incrementRandomDigits = (digits: ReadonlyArray<number>) => {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const value = next[i];
    if (typeof value !== "number") {
      continue;
    }
    if (value === 31) {
      next[i] = 0;
      if (i === 0) {
        return { digits: next, overflow: true } as const;
      }
    } else {
      next[i] = value + 1;
      return { digits: next, overflow: false } as const;
    }
  }
  return { digits: next, overflow: true } as const;
};

const eventKey = (event: PostEvent, id: EventId) =>
  `events/${event.meta.source}/${id}`;
const manifestKey = "events/manifest";
const lastEventIdKey = "events/last-id";

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

export class StoreWriter extends Context.Tag("@skygent/StoreWriter")<
  StoreWriter,
  {
    readonly append: (
      store: StoreRef,
      event: PostEvent
    ) => Effect.Effect<PostEventRecord, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    StoreWriter,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const events = kv.forSchema(PostEventRecord);
      const manifest = kv.forSchema(Schema.Array(Schema.String));
      const lastEventId = kv.forSchema(EventId);
      const idState = yield* Ref.make({
        lastTime: 0,
        lastRandom: [] as ReadonlyArray<number>
      });

      const nextRandomDigits = () =>
        Effect.forEach(
          Array.from({ length: 16 }),
          () => Random.nextIntBetween(0, 32)
        );

      const generateEventId = Effect.fn("StoreWriter.generateEventId")(() =>
        Effect.gen(function* () {
          const state = yield* Ref.get(idState);
          const now = Date.now();
          let time = state.lastTime;
          let digits = state.lastRandom;

          if (digits.length === 0 || now > state.lastTime) {
            time = now;
            digits = yield* nextRandomDigits();
          } else {
            const incremented = incrementRandomDigits(digits);
            if (incremented.overflow) {
              time = state.lastTime + 1;
              digits = yield* nextRandomDigits();
            } else {
              time = state.lastTime;
              digits = incremented.digits;
            }
          }

          const id = `${encodeTime(time)}${encodeRandomDigits(digits)}`;
          const decoded = yield* Schema.decodeUnknown(EventId)(id);
          yield* Ref.set(idState, { lastTime: time, lastRandom: digits });
          return decoded;
        }).pipe(Effect.orDie)
      );

      const append = Effect.fn("StoreWriter.append")(
        (store: StoreRef, event: PostEvent) =>
          Effect.gen(function* () {
            const prefix = storePrefix(store);
            const storeEvents = KeyValueStore.prefix(events, prefix);
            const storeManifest = KeyValueStore.prefix(manifest, prefix);
            const storeLastEventId = KeyValueStore.prefix(lastEventId, prefix);
            const id = yield* generateEventId();
            const record = PostEventRecord.make({
              id,
              version: 1,
              event
            });
            const key = eventKey(event, id);
            yield* storeEvents.set(key, record);
            yield* storeLastEventId.set(lastEventIdKey, record.id);
            const updated = yield* storeManifest.modify(manifestKey, (keys) => [
              ...keys,
              key
            ]);
            if (Option.isNone(updated)) {
              yield* storeManifest.set(manifestKey, [key]);
            }
            return record;
          }).pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      return StoreWriter.of({ append });
    })
  );
}
