/**
 * Chat in the stream: whatever the transport, messages heard become
 * `perception.chat.{dm,group}` entries and messages sent become
 * `effector.said.{dm,group}` (docs/stream.md).
 */

import type { ChatAdapter } from "./types.js";
import { appendStream } from "../../core/stream.js";

export function tapChatIntoStream(adapter: ChatAdapter, nameOf: (id: string) => Promise<string | null>): ChatAdapter {
  adapter.onMessage(async (msg) => {
    const who = msg.from.name || (await nameOf(msg.from.id)) || msg.from.id;
    const where = msg.chatType === "group" ? ` in ${msg.groupName ?? "a group"}` : "";
    const attached = msg.attachments?.length ? ` [${msg.attachments.length} attachment(s)]` : "";
    await appendStream({
      category: `perception.chat.${msg.chatType}`,
      author: "chat",
      text: `${who}${where}: ${msg.text || ""}${attached}`,
      fromId: msg.from.id,
      groupId: msg.groupId,
    });
  });

  const send = adapter.send.bind(adapter);
  adapter.send = async (msg) => {
    await send(msg);
    if (!msg.text?.trim()) return;
    const to = msg.groupId ? "the group" : (await nameOf(msg.to)) ?? msg.to;
    await appendStream({
      category: `effector.said.${msg.groupId ? "group" : "dm"}`,
      author: "chat",
      text: `to ${to}: ${msg.text}`,
      toId: msg.to,
      groupId: msg.groupId,
    });
  };
  return adapter;
}
