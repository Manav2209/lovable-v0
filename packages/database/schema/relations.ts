// schema/relations.ts
import { relations } from "drizzle-orm";
import { users, projects, conversationHistory } from "./tables";

/**
 * Users Relations
 * A user has many projects
 */
export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
}));

/**
 * Projects Relations
 * A project belongs to one user
 * A project has many conversation history entries
 */
export const projectsRelations = relations(projects, ({ one, many }) => ({
  // One project belongs to one user
  user: one(users, {
    fields: [projects.userId],
    references: [users.id],
  }),
  
  // One project has many conversations
  conversationHistory: many(conversationHistory),
}));

/**
 * ConversationHistory Relations
 * Each conversation belongs to one project
 */
export const conversationHistoryRelations = relations(
  conversationHistory,
  ({ one }) => ({
    // One conversation belongs to one project
    project: one(projects, {
      fields: [conversationHistory.projectId],
      references: [projects.id],
    }),
  })
);