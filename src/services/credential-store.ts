/**
 * Credential Store Service
 *
 * Manages Bluesky authentication credentials with secure storage.
 * Credentials are encrypted using AES-GCM with PBKDF2 key derivation
 * and stored in a JSON file within the store root directory.
 *
 * The service supports multiple credential sources with the following priority:
 * 1. Runtime overrides (via CredentialsOverrides context)
 * 2. Environment variables (SKYGENT_IDENTIFIER, SKYGENT_PASSWORD)
 * 3. Encrypted credentials file (requires SKYGENT_CREDENTIALS_KEY)
 * 4. Config file defaults
 *
 * **Environment Variables:**
 * - `SKYGENT_IDENTIFIER` - Bluesky handle or DID
 * - `SKYGENT_PASSWORD` - App-specific password (redacted)
 * - `SKYGENT_CREDENTIALS_KEY` - Master key for encrypting/decrypting stored credentials
 *
 * **Security:**
 * - Passwords are stored as Redacted values to prevent accidental logging
 * - Encryption uses 100,000 PBKDF2 iterations with SHA-256
 * - Random 16-byte salt and 12-byte IV per encryption
 *
 * @module services/credential-store
 *
 * @example
 * ```typescript
 * import { CredentialStore } from "./services/credential-store.js";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const store = yield* CredentialStore;
 *
 *   // Save credentials (requires SKYGENT_CREDENTIALS_KEY)
 *   yield* store.save({
 *     identifier: "handle.bsky.social",
 *     password: Redacted.make("app-password")
 *   });
 *
 *   // Retrieve credentials
 *   const creds = yield* store.require();
 *   console.log(creds.identifier);
 * });
 * ```
 */

import { FileSystem, Path } from "@effect/platform";
import { formatSchemaError } from "./shared.js";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema
} from "effect";
import { AppConfigService } from "./app-config.js";
import { BskyCredentials } from "../domain/credentials.js";
import { CredentialError } from "../domain/errors.js";

/**
 * Value type for runtime credential overrides.
 * Used to inject credentials for testing or one-off operations.
 */
export type CredentialsOverridesValue = {
  /** Bluesky handle or DID */
  readonly identifier?: string;
  /** App-specific password (should be Redacted) */
  readonly password?: Redacted.Redacted<string>;
};

/**
 * Context tag for runtime credential overrides.
 * Provides a way to inject credentials outside of the normal resolution chain.
 *
 * @example
 * ```typescript
 * const withOverrides = program.pipe(
 *   Effect.provideService(CredentialsOverrides, {
 *     identifier: "test.handle",
 *     password: Redacted.make("test-pass")
 *   })
 * );
 * ```
 */
export class CredentialsOverrides extends Context.Tag("@skygent/CredentialsOverrides")<
  CredentialsOverrides,
  CredentialsOverridesValue
>() {
  /** Empty layer for when no overrides are needed */
  static readonly layer = Layer.succeed(CredentialsOverrides, {});
}

const credentialsFileName = "credentials.json";

class CredentialsPayload extends Schema.Class<CredentialsPayload>("CredentialsPayload")({
  identifier: Schema.String,
  password: Schema.String
}) {}

class CredentialsFile extends Schema.Class<CredentialsFile>("CredentialsFile")({
  version: Schema.Literal(1),
  salt: Schema.String,
  iv: Schema.String,
  ciphertext: Schema.String
}) {}


const toCredentialError = (message: string) => (cause: unknown) =>
  CredentialError.make({ message, cause });

const encodeBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const decodeBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

const deriveKey = (secret: string, salt: Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      const saltBuffer: ArrayBuffer =
        salt.buffer instanceof ArrayBuffer ? salt.buffer : new Uint8Array(salt).buffer;
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "PBKDF2",
        false,
        ["deriveKey"]
      );
      return crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: saltBuffer,
          iterations: 100_000,
          hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
    },
    catch: toCredentialError("Failed to derive credentials key")
  });

const encryptPayload = (secret: string, payload: CredentialsPayload) =>
  Effect.gen(function* () {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = yield* deriveKey(secret, salt);
    const payloadJson = yield* Schema.encodeUnknown(
      Schema.parseJson(CredentialsPayload)
    )(payload).pipe(
      Effect.mapError((error) =>
        CredentialError.make({
          message: `Invalid credentials payload: ${formatSchemaError(error)}`,
          cause: error
        })
      )
    );
    const encoded = new TextEncoder().encode(payloadJson);
    const ciphertext = yield* Effect.tryPromise({
      try: async () => {
        const result = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
        return new Uint8Array(result);
      },
      catch: toCredentialError("Failed to encrypt credentials")
    });
    return CredentialsFile.make({
      version: 1,
      salt: encodeBase64(salt),
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(ciphertext)
    });
  });

const decryptPayload = (secret: string, file: CredentialsFile) =>
  Effect.gen(function* () {
    const salt = decodeBase64(file.salt);
    const iv = decodeBase64(file.iv);
    const key = yield* deriveKey(secret, salt);
    const plaintext = yield* Effect.tryPromise({
      try: async () => {
        const result = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          decodeBase64(file.ciphertext)
        );
        return new TextDecoder().decode(result);
      },
      catch: toCredentialError("Failed to decrypt credentials")
    });
    return yield* Schema.decodeUnknown(
      Schema.parseJson(CredentialsPayload)
    )(plaintext).pipe(
      Effect.mapError((error) =>
        CredentialError.make({
          message: `Invalid credentials payload: ${formatSchemaError(error)}`,
          cause: error
        })
      )
    );
  });

const decodeCredentialsFile = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(CredentialsFile))(raw).pipe(
    Effect.mapError((error) =>
      CredentialError.make({
        message: `Invalid credentials file: ${formatSchemaError(error)}`,
        cause: error
      })
    )
  );

/**
 * Interface for the credential store service.
 * Defines operations for retrieving and storing Bluesky credentials.
 */
export interface CredentialStoreService {
  /**
   * Retrieves credentials from any available source.
   * Returns Option.none if no credentials are configured.
   *
   * @returns Effect resolving to Some(credentials) or None
   */
  readonly get: () => Effect.Effect<Option.Option<BskyCredentials>, CredentialError>;

  /**
   * Retrieves credentials, failing if none are available.
   *
   * @returns Effect resolving to credentials
   * @throws {CredentialError} When no credentials are configured
   */
  readonly require: () => Effect.Effect<BskyCredentials, CredentialError>;

  /**
   * Saves credentials to the encrypted file.
   * Requires SKYGENT_CREDENTIALS_KEY environment variable.
   *
   * @param credentials - The credentials to encrypt and store
   * @returns Effect resolving to void on success
   * @throws {CredentialError} When encryption fails or env key is missing
   */
  readonly save: (credentials: BskyCredentials) => Effect.Effect<void, CredentialError>;
}

/**
 * Context tag and Layer implementation for the credential store service.
 * Manages the lifecycle of credential storage and retrieval.
 *
 * **Resolution Priority:**
 * 1. CredentialsOverrides context (for testing/runtime injection)
 * 2. SKYGENT_IDENTIFIER / SKYGENT_PASSWORD environment variables
 * 3. Encrypted credentials file (decrypted with SKYGENT_CREDENTIALS_KEY)
 * 4. Config file identifier (password not supported in config)
 *
 * @example
 * ```typescript
 * // Basic usage with layer
 * const program = Effect.gen(function* () {
 *   const store = yield* CredentialStore;
 *   const creds = yield* store.require();
 * }).pipe(Effect.provide(CredentialStore.layer));
 *
 * // Testing with empty store
 * const testProgram = program.pipe(
 *   Effect.provide(CredentialStore.testLayer)
 * );
 * ```
 */
export class CredentialStore extends Context.Tag("@skygent/CredentialStore")<
  CredentialStore,
  CredentialStoreService
>() {
  /**
   * Production layer that creates the credential store service.
   * Requires AppConfigService and FileSystem services.
   */
  static readonly layer = Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      const overrides = yield* CredentialsOverrides;
      const config = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const credentialsPath = path.join(config.storeRoot, credentialsFileName);

      const envIdentifier = yield* Config.string("SKYGENT_IDENTIFIER").pipe(Config.option);
      const envPassword = yield* Config.redacted("SKYGENT_PASSWORD").pipe(Config.option);
      const envKey = yield* Config.redacted("SKYGENT_CREDENTIALS_KEY").pipe(
        Config.option
      );

      const loadFromFile = Effect.gen(function* () {
        const exists = yield* fs.exists(credentialsPath).pipe(
          Effect.mapError(toCredentialError("Failed to check credentials file"))
        );
        if (!exists) {
          return Option.none<CredentialsPayload>();
        }
        if (Option.isNone(envKey)) {
          return yield* CredentialError.make({
            message:
              "Credentials file exists but SKYGENT_CREDENTIALS_KEY is not set."
          });
        }
        const raw = yield* fs.readFileString(credentialsPath).pipe(
          Effect.mapError(toCredentialError("Failed to read credentials file"))
        );
        const file = yield* decodeCredentialsFile(raw);
        const payload = yield* decryptPayload(Redacted.value(envKey.value), file);
        return Option.some(payload);
      });

      const resolveIdentifier = (
        filePayload: Option.Option<CredentialsPayload>
      ): string | undefined =>
        overrides.identifier ??
        Option.getOrUndefined(envIdentifier) ??
        Option.getOrUndefined(Option.map(filePayload, (payload) => payload.identifier)) ??
        config.identifier;

      const resolvePassword = (
        filePayload: Option.Option<CredentialsPayload>
      ): Redacted.Redacted<string> | undefined =>
        overrides.password ??
        Option.getOrUndefined(envPassword) ??
        Option.getOrUndefined(
          Option.map(filePayload, (payload) => Redacted.make(payload.password))
        );

      const get = Effect.fn("CredentialStore.get")(() =>
        Effect.gen(function* () {
          const filePayload = yield* loadFromFile;
          const identifier = resolveIdentifier(filePayload);
          const password = resolvePassword(filePayload);
          if (!identifier || !password) {
            return Option.none<BskyCredentials>();
          }
          const creds = BskyCredentials.make({ identifier, password });
          return Option.some(creds);
        })
      );

      const require = Effect.fn("CredentialStore.require")(() =>
        get().pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                CredentialError.make({
                  message: "Missing Bluesky credentials."
                }),
              onSome: Effect.succeed
            })
          )
        )
      );

      const save = Effect.fn("CredentialStore.save")((credentials: BskyCredentials) =>
        Effect.gen(function* () {
          if (Option.isNone(envKey)) {
            return yield* CredentialError.make({
              message:
                "SKYGENT_CREDENTIALS_KEY is required to save encrypted credentials."
            });
          }
          const payload = CredentialsPayload.make({
            identifier: credentials.identifier,
            password: Redacted.value(credentials.password)
          });
          const file = yield* encryptPayload(Redacted.value(envKey.value), payload);
          yield* fs
            .makeDirectory(config.storeRoot, { recursive: true })
            .pipe(Effect.mapError(toCredentialError("Failed to create credentials directory")));
          const encoded = yield* Schema.encodeUnknown(
            Schema.parseJson(CredentialsFile)
          )(file).pipe(
            Effect.mapError((error) =>
              CredentialError.make({
                message: `Invalid credentials file: ${formatSchemaError(error)}`,
                cause: error
              })
            )
          );
          yield* fs
            .writeFileString(credentialsPath, encoded)
            .pipe(Effect.mapError(toCredentialError("Failed to write credentials file")));
        })
      );

      return CredentialStore.of({ get, require, save });
    })
  );

  /**
   * Test layer that provides an empty credential store.
   * Useful for tests where authentication is not needed.
   * get() returns None, require() fails with CredentialError.
   */
  static readonly testLayer = Layer.succeed(
    CredentialStore,
    CredentialStore.of({
      get: () => Effect.succeed(Option.none()),
      require: () =>
        Effect.fail(CredentialError.make({ message: "Missing Bluesky credentials." })),
      save: () => Effect.void
    })
  );
}
