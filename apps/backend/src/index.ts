import "dotenv/config";
import cors from "cors";
import express from "express";
import bcrypt from "bcrypt"
import jwt from "jsonwebtoken";
import { eq, and, desc, asc } from "drizzle-orm";
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText } from 'ai';
import { Sandbox } from '@e2b/code-interpreter'

import {
  LoginSchema,
  SignUpSchema,
  conversationSchema,
  createProjectSchema,
} from "./lib/schema";

import { authMiddleware } from "./lib/middleware";
import { createTitle } from "./lib/helper";

import { db }  from "database"

import { SYSTEM_PROMPT } from "./lib/prompt";

import { conversationHistory, projects, users } from "../../../packages/database/schema/tables";
import { createSandboxTools } from "./lib/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

const app = express();

app.use(express.json());
app.use(cors());

app.post("/signup", async (req, res) => {
  const { success, data } = SignUpSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({
      success: false,
      data: null,
      error: "INVALID_REQUEST",
    });
  }

  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, data.email))
    .limit(1);

  if (existingUser.length > 0) {
    return res.status(400).json({
      success: false,
      data: null,
      error: "EMAIL_ALREADY_EXISTS",
    });
  }

  const hashedPassword = await bcrypt.hash(data.password, 10);

  const [user] = await db
    .insert(users)
    .values({
      email: data.email,
      username: data.username,
      password: hashedPassword,
    })
    .returning();

  return res.status(201).json({
    success: true,
    data: user,
    error: null,
  });
});


app.post("/login", async (req, res) => {
  const { success, data } = LoginSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({
      success: false,
      data: null,
      error: "INVALID_REQUEST",
    });
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, data.email))
    .limit(1);

  const user = result[0];

  if (!user) {
    return res.status(401).json({
      success: false,
      data: null,
      error: "EMAIL_DOESNOT_EXISTS",
    });
  }

  const validPassword = await bcrypt.compare(
    data.password,
    user.password
  );

  if (!validPassword) {
    return res.status(401).json({
      success: false,
      data: null,
      error: "INVALID_CREDENTIALS",
    });
  }

  const token = jwt.sign(
    { id: user.id },
    process.env.JWT_SECRET!
  );

  return res.status(200).json({
    success: true,
    data: {
      token,
      user,
    },
    error: null,
  });
});

app.post("/project", authMiddleware, async (req, res) => {
  const { success, data } = createProjectSchema.safeParse(req.body);

  if (!success) {
    return res.status(400).json({
      success: false,
      data: null,
      error: "INVALID_REQUEST",
    });
  }

  const title = await createTitle(data.prompt);

  const [project] = await db
    .insert(projects)
    .values({
      title,
      initialPrompt: data.prompt,
      userId: req.userId!,
    })
    .returning();

  return res.status(201).json({
    success: true,
    data: project,
    error: null,
  });
});


app.get("/projects", authMiddleware, async (req, res) => {
  const userProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, req.userId!))
    .orderBy(desc(projects.createdAt));

  return res.status(200).json({
    success: true,
    data: userProjects,
    error: null,
  });
});

app.get("/project/:projectId", authMiddleware, async (req, res) => {
  const { projectId } = req.params;

  const projectResult = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.userId, req.userId!)
      )
    )
    .limit(1);

  if (projectResult.length === 0) {
    return res.status(404).json({
      success: false,
      data: null,
      error: "PROJECT_NOT_FOUND",
    });
  }

  const history = await db
    .select()
    .from(conversationHistory)
    .where(eq(conversationHistory.projectId, projectId))
    .orderBy(asc(conversationHistory.createdAt));

  return res.status(200).json({
    success: true,
    data: {
      ...projectResult[0],
      conversationHistory: history,
    },
    error: null,
  });
});


app.post(
  "/project/conversation/:projectId",
  authMiddleware,
  async (req, res) => {
    const { projectId } = req.params;
    const { success, data } = conversationSchema.safeParse(req.body);

    if (!success) {
      return res.status(400).json({
        success: false,
        data: null,
        error: "INVALID_REQUEST",
      });
    }

    const project = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.userId, req.userId!)
        )
      )
      .limit(1);

    if (project.length === 0) {
      return res.status(404).json({
        success: false,
        data: null,
        error: "PROJECT_NOT_FOUND",
      });
    }

    const [message] = await db
      .insert(conversationHistory)
      .values({
        projectId,
        type: data.type,
        from: data.from,
        contents: data.contents,
        toolCall: data.toolCall ?? null,
      })
      .returning();

    return res.status(201).json({
      success: true,
      data: message,
      error: null,
    });
  }
);

app.post("/prompt", async(req, res) => {
  const { prompt } = req.body;
  const TEMPLATE_ID='006p4gym7bnhmfpwl03u'

  const sandbox = await Sandbox.create(TEMPLATE_ID)
  const host = sandbox.getHost(5173)

  const tools = createSandboxTools(sandbox);
  const agent = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    temperature: 0,
    streaming: true,
  }).bindTools(tools);
  


  const stream = await agent.stream([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ]);

  for await (const chunk of stream) {
    // Optional: log tool calls
    if (chunk.tool_calls?.length) {
      for (const call of chunk.tool_calls) {
        console.log("TOOL:", call.name, call.args.location);
      }
    }
  }
  
  await sandbox.runCode("npm install");
  await sandbox.runCode("npm run dev")


    res.json({
      url: `https://${host}`
    })

});
app.listen(3000, () => {
  console.log("App is listening on port 3000");
});
