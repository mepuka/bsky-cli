import { Schema } from "effect";

export class BskyCredentials extends Schema.Class<BskyCredentials>("BskyCredentials")({
  identifier: Schema.String,
  password: Schema.Redacted(Schema.String)
}) {}
