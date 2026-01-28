// schema/enums.ts
import { pgEnum } from "drizzle-orm/pg-core";

export const conversationTypeEnum = pgEnum("conversation_type", [
  "TOOL_CALL",
  "TEXT_MESSAGE",
]);

export const messageFromEnum = pgEnum("message_from", [
  "USER",
  "ASSISTANT",
]);

export const toolCallEnum = pgEnum("tool_call", [
  "READ_FILE",
  "WRITE_FILE",
  "DELETE_FILE",
  "UPDATE_FILE",
]);
