import {
    pgTable,
    text,
    timestamp,
    boolean,
    pgEnum,
    index,
  } from "drizzle-orm/pg-core";
import { conversationTypeEnum, messageFromEnum, toolCallEnum } from "./enums";
  
 

  export const users = pgTable("users", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    username: text("username").notNull(),
    email: text("email").notNull().unique(),
    password: text("password").notNull(),
  
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  });
  

  export const projects = pgTable("projects", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    initialPrompt: text("initial_prompt").notNull(),
  
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  });
  

  
  export const conversationHistory = pgTable(
    "conversation_history",
    {
      id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  
      projectId: text("project_id")
        .notNull()
        .references(() => projects.id, { onDelete: "cascade" }),
  
      type: conversationTypeEnum("type").notNull(),
      from: messageFromEnum("from").notNull(),
      contents: text("contents").notNull(),
  
      hidden: boolean("hidden").default(false).notNull(),
      toolCall: toolCallEnum("tool_call"),
  
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (table) => ({
      projectIdx: index("conversation_project_idx").on(table.projectId),
    })
  );
  