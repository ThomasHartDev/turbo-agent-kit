import type { Channel, Conversation, Message } from "@agent/core";
import { z } from "zod";
import type { RedisPort } from "./redis-port";

const ChannelSchema = z.enum(["chat", "sms", "voice"]);

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCall: z
    .object({
      id: z.string(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()),
    })
    .optional(),
  toolCallId: z.string().optional(),
}) satisfies z.ZodType<Message>;

const MetaSchema = z.object({ id: z.string(), channel: ChannelSchema });

export interface AsyncConversationStore {
  get(id: string): Promise<Conversation | undefined>;
  create(channel: Channel): Promise<Conversation>;
  append(id: string, message: Message): Promise<Conversation>;
}

export interface RedisConversationStoreOptions {
  keyPrefix?: string;
  ttlSeconds?: number; // slides forward on every append so idle conversations expire
}

export class ConversationNotFoundError extends Error {
  constructor(id: string) {
    super(`conversation ${id} not found`);
    this.name = "ConversationNotFoundError";
  }
}

// Metadata lives in a string key and messages in a Redis list, so an append is a
// single atomic RPUSH with no read-modify-write race between concurrent writers.
export class RedisConversationStore implements AsyncConversationStore {
  private readonly prefix: string;
  private readonly ttlSeconds?: number;

  constructor(
    private readonly redis: RedisPort,
    options: RedisConversationStoreOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? "conv:";
    this.ttlSeconds = options.ttlSeconds;
  }

  private metaKey(id: string): string {
    return `${this.prefix}${id}`;
  }

  private messagesKey(id: string): string {
    return `${this.prefix}${id}:messages`;
  }

  async create(channel: Channel): Promise<Conversation> {
    const convo: Conversation = { id: crypto.randomUUID(), channel, messages: [] };
    await this.redis.set(
      this.metaKey(convo.id),
      JSON.stringify({ id: convo.id, channel }),
      this.ttlSeconds,
    );
    return convo;
  }

  async get(id: string): Promise<Conversation | undefined> {
    const rawMeta = await this.redis.get(this.metaKey(id));
    if (rawMeta === null) return undefined;
    const meta = MetaSchema.parse(JSON.parse(rawMeta));
    const rawMessages = await this.redis.lrange(this.messagesKey(id), 0, -1);
    const messages = rawMessages.map((raw) => MessageSchema.parse(JSON.parse(raw)));
    return { id: meta.id, channel: meta.channel, messages };
  }

  async append(id: string, message: Message): Promise<Conversation> {
    const parsed = MessageSchema.parse(message);
    if ((await this.redis.get(this.metaKey(id))) === null) {
      throw new ConversationNotFoundError(id);
    }
    await this.redis.rpush(this.messagesKey(id), JSON.stringify(parsed));
    if (this.ttlSeconds !== undefined) {
      await this.redis.expire(this.metaKey(id), this.ttlSeconds);
      await this.redis.expire(this.messagesKey(id), this.ttlSeconds);
    }
    const convo = await this.get(id);
    if (!convo) throw new ConversationNotFoundError(id);
    return convo;
  }
}
