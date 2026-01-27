import { Context, Effect, Layer, ParseResult, Schema } from "effect";
import { Post } from "../domain/post.js";
import { PostFromRaw } from "../domain/raw.js";

export class PostParser extends Context.Tag("@skygent/PostParser")<
  PostParser,
  {
    readonly parsePost: (raw: unknown) => Effect.Effect<Post, ParseResult.ParseError>;
  }
>() {
  static readonly layer = Layer.succeed(
    PostParser,
    PostParser.of({
      parsePost: Effect.fn("PostParser.parsePost")((raw: unknown) =>
        Schema.decodeUnknown(PostFromRaw)(raw)
      )
    })
  );
}
