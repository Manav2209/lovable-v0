CREATE TYPE "public"."conversation_type" AS ENUM('TOOL_CALL', 'TEXT_MESSAGE');--> statement-breakpoint
CREATE TYPE "public"."message_from" AS ENUM('USER', 'ASSISTANT');--> statement-breakpoint
CREATE TYPE "public"."tool_call" AS ENUM('READ_FILE', 'WRITE_FILE', 'DELETE_FILE', 'UPDATE_FILE');--> statement-breakpoint
CREATE TABLE "conversation_history" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" "conversation_type" NOT NULL,
	"from" "message_from" NOT NULL,
	"contents" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"tool_call" "tool_call",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"initial_prompt" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "conversation_history" ADD CONSTRAINT "conversation_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_project_idx" ON "conversation_history" USING btree ("project_id");