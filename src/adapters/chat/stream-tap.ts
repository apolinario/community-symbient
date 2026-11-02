/**
 * Chat in the stream: whatever the transport, messages heard become
 * `perception.chat.{dm,group}` entries and messages sent become
 * `effector.said.{dm,group}` (docs/stream.md).
 */

import type { ChatAdapter } from "./types.js";
import { appendStream } from "../../core/stream.js";

/** `key` names the person across transports (a people/ slug), so `with` matches whichever id a message used. */
export function tapChatIntoStream(adapter: ChatAdapter, personOf: (id: string) => Promise<{ name: string; key: string } | null>): ChatAdapter {
  adapter.onMessage(async (msg) => {
    const person = await personOf(msg.from.id);
    const who = msg.from.name || person?.name || msg.from.id;
    const where = msg.chatType === "group" ? ` in ${msg.groupName ?? "a group"}` : "";
    const attached = msg.attachments?.length ? ` [${msg.attachments.length} attachment(s)]` : "";
    await appendStream({
      category: `perception.chat.${msg.chatType}`,
      author: "chat",
      text: `${who}${where}: ${msg.text || ""}${attached}`,
      fromId: msg.from.id,
      groupId: msg.groupId,
      with: msg.chatType === "dm" ? person?.key ?? msg.from.id : undefined,
    });
  });

  const send = adapter.send.bind(adapter);
  adapter.send = async (msg) => {
    await send(msg);
    if (!msg.text?.trim()) return;
    const person = msg.groupId ? null : await personOf(msg.to);
    const to = msg.groupId ? "the group" : person?.name ?? msg.to;
    await appendStream({
      category: `effector.said.${msg.groupId ? "group" : "dm"}`,
      author: "chat",
      text: `to ${to}: ${msg.text}`,
      toId: msg.to,
      groupId: msg.groupId,
      with: msg.groupId ? undefined : person?.key ?? msg.to,
    });
  };
  return adapter;
}
