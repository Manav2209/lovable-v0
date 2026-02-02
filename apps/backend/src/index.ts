import "dotenv/config";
import cors from "cors";
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { eq, and, desc, asc } from "drizzle-orm";
import {
  LoginSchema,
  SignUpSchema,
  conversationSchema,
  createProjectSchema,
} from "./lib/schema";
import { authMiddleware } from "./middleware";
import { createTitle } from "./lib/helper";
import { db } from "database";
import {
  conversationHistory,
  projects,
  users,
} from "../../../packages/database/schema/tables";


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

  const validPassword = await bcrypt.compare(data.password, user.password);

  if (!validPassword) {
    return res.status(401).json({
      success: false,
      data: null,
      error: "INVALID_CREDENTIALS",
    });
  }

  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET!);

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
      error: "INVALID_REQUEST"
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

    const [message] = await db
    .insert(conversationHistory)
    .values({
      projectId: project!.id,
      type: "TEXT_MESSAGE",
      from: "USER",
      contents: data.prompt,
      toolCall: null,
    })
    .returning();

  return res.status(201).json({
    success: true,
    data: {
      project,
      messageId: message!.id,
    },
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
    .where(and(eq(projects.id, projectId), eq(projects.userId, req.userId!)))
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

app.post("/project/conversation/:projectId", authMiddleware, async (req, res) => {
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
      .where(and(eq(projects.id, projectId), eq(projects.userId, req.userId!)))
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


// app.post("/project/:projectId/run" , authMiddleware , async (req , res) => {
//   const projectId = req.params.projectId;




// })



app.listen(3000, () => {
  console.log("App is listening on port 3000");
});
