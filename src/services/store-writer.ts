import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Context, Effect, Layer, Option, Random, Schema } from "effect";
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

const randomPart = Effect.forEach(
  Array.from({ length: 16 }),
  () => Random.nextIntBetween(0, 32)
).pipe(
  Effect.map((digits) => digits.map((digit) => ULID_ALPHABET[digit]).join(""))
);

const generateEventId = Effect.gen(function* () {
  const timePart = encodeTime(Date.now());
  const rand = yield* randomPart;
  const id = `${timePart}${rand}`;
  return yield* Schema.decodeUnknown(EventId)(id);
}).pipe(Effect.orDie);

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

      const append = Effect.fn("StoreWriter.append")(
        (store: StoreRef, event: PostEvent) =>
          Effect.gen(function* () {
            const prefix = storePrefix(store);
            const storeEvents = KeyValueStore.prefix(events, prefix);
            const storeManifest = KeyValueStore.prefix(manifest, prefix);
            const storeLastEventId = KeyValueStore.prefix(lastEventId, prefix);
            const id = yield* generateEventId;
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
