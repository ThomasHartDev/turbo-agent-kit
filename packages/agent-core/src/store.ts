import type { Channel, Conversation } from "./types";

export interface ConversationStore {
  get(id: string): Conversation | undefined;
  create(channel: Channel): Conversation;
}

export class InMemoryConversationStore implements ConversationStore {
  private map = new Map<string, Conversation>(); // In-memory stand-in for Redis

  get(id: string): Conversation | undefined {
    return this.map.get(id);
  }

  create(channel: Channel): Conversation {
    const convo: Conversation = { id: crypto.randomUUID(), channel, messages: [] };
    this.map.set(convo.id, convo);
    return convo;
  }
}
