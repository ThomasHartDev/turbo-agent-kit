import type { Message } from "@agent/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryRedis } from "./in-memory-redis";
import { ConversationNotFoundError, RedisConversationStore } from "./conversation-store";
import { createConversationStore } from "./index";

function manualClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const user = (content: string): Message => ({ role: "user", content });

describe("RedisConversationStore", () => {
  let redis: InMemoryRedis;
  let store: RedisConversationStore;

  beforeEach(() => {
    redis = new InMemoryRedis();
    store = new RedisConversationStore(redis);
  });

  it("creates and reads back a conversation", async () => {
    const convo = await store.create("chat");
    expect(convo.messages).toEqual([]);
    const loaded = await store.get(convo.id);
    expect(loaded).toEqual({ id: convo.id, channel: "chat", messages: [] });
  });

  it("returns undefined for an unknown id", async () => {
    expect(await store.get("nope")).toBeUndefined();
  });

  it("appends messages in order and preserves tool calls", async () => {
    const convo = await store.create("chat");
    await store.append(convo.id, user("hi"));
    const withTool: Message = {
      role: "assistant",
      content: "",
      toolCall: { id: "t1", name: "search", args: { q: "weather" } },
    };
    const after = await store.append(convo.id, withTool);
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0]).toEqual(user("hi"));
    expect(after.messages[1]).toEqual(withTool);
  });

  it("throws when appending to a missing conversation", async () => {
    await expect(store.append("ghost", user("hi"))).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });

  it("rejects a structurally invalid message", async () => {
    const convo = await store.create("chat");
    const bad = { role: "wizard", content: "hi" } as unknown as Message;
    await expect(store.append(convo.id, bad)).rejects.toThrow();
  });

  it("keeps separate conversations isolated", async () => {
    const a = await store.create("chat");
    const b = await store.create("sms");
    await store.append(a.id, user("for a"));
    expect((await store.get(a.id))?.messages).toHaveLength(1);
    expect((await store.get(b.id))?.messages).toHaveLength(0);
  });

  it("expires an idle conversation and slides the ttl on append", async () => {
    const clock = manualClock();
    redis = new InMemoryRedis(clock.now);
    store = new RedisConversationStore(redis, { ttlSeconds: 10 });
    const convo = await store.create("chat");

    clock.advance(6_000);
    await store.append(convo.id, user("still here")); // ttl slides to now + 10s
    clock.advance(6_000); // 12s since create, but only 6s since the append
    expect(await store.get(convo.id)).toBeDefined();

    clock.advance(10_000); // now past the slid ttl
    expect(await store.get(convo.id)).toBeUndefined();
  });
});

describe("createConversationStore", () => {
  it("falls back to an in-memory store with no client", async () => {
    const store = createConversationStore();
    const convo = await store.create("voice");
    await store.append(convo.id, user("hello"));
    expect((await store.get(convo.id))?.messages).toHaveLength(1);
  });
});
