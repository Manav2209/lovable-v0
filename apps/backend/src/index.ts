import "dotenv/config";
import cors from "cors";
import express from "express";
import { authRouter } from "./routes/auth";
import { projectRouter } from "./routes/project";


const app = express();

app.use(express.json());
app.use(cors());
app.use("/api/v1/auth" ,authRouter);
app.use("/api/v1" , projectRouter)





app.listen(3000, () => {
  console.log("App is listening on port 3000");
});

